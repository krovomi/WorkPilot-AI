/**
 * Docker Sandboxes (`sbx`) from the main process: whether it is ready, for
 * Settings > Sandbox, and the removal of a task's microVM with its worktree.
 *
 * The VM itself is created by the build (`apps/backend/os_sandbox/microvm.py`);
 * its name is the same hash of the worktree path on both sides
 * (`microvmName`, tested against the same vector as `vm_name`). Every call
 * runs without a shell, never prompts (`--no-input`) and with
 * `SBX_NO_TELEMETRY=1`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { MicrovmStatus } from "../../shared/types/task-sandbox";
import { findExecutable, isWindows } from "../platform";
import { envWithoutCredentials } from "../utils/child-env";

const execute = promisify(execFile);
const TIMEOUT_MS = 60_000;
export const MICROVM_PREFIX = "workpilot-";

/** Where the sbx installers put it, for an app started before its PATH changed. */
function installDirs(): string[] {
	if (!isWindows()) return [];
	return [process.env.LOCALAPPDATA, process.env.ProgramFiles]
		.filter((base): base is string => Boolean(base))
		.flatMap((base) => [path.join(base, "DockerSandboxes", "bin"), path.join(base, "DockerSandboxes")]);
}

export function sbxPath(): string | null {
	return findExecutable("sbx", installDirs());
}

/** The VM of a worktree, as the backend names it (`os_sandbox.microvm.vm_name`). */
export function microvmName(worktree: string, windows = isWindows()): string {
	let key = worktree;
	try {
		key = realpathSync.native(worktree);
	} catch {
		key = path.resolve(worktree);
	}
	if (windows) key = key.toLowerCase();
	return MICROVM_PREFIX + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

type Run = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const run: Run = (file, args) =>
	execute(file, ["--no-input", ...args], {
		timeout: TIMEOUT_MS,
		windowsHide: true,
		// sbx keeps its own sign-in in the system keychain: none of WorkPilot's.
		env: envWithoutCredentials(process.env, { SBX_NO_TELEMETRY: "1" }),
		encoding: "utf8",
	});

function detail(error: unknown): string {
	const text =
		(error as { stderr?: string })?.stderr || (error instanceof Error ? error.message : String(error));
	const lines = text.trim().split(/\r?\n/);
	return (lines.at(-1) ?? "").slice(0, 300);
}

/** Whether sbx is installed, answers and is signed in; read, never acted on. */
export async function microvmStatus(exec: Run = run, sbx = sbxPath()): Promise<MicrovmStatus> {
	if (!sbx) return { installed: false, ready: false, version: null, vms: 0, reason: null };
	let version: string | null = null;
	try {
		const { stdout } = await exec(sbx, ["version"]);
		version = stdout.trim().split(/\r?\n/)[0]?.slice(0, 120) || null;
	} catch (error) {
		return { installed: true, ready: false, version: null, vms: 0, reason: detail(error) };
	}
	try {
		const { stdout } = await exec(sbx, ["ls", "--json"]);
		const parsed: unknown = JSON.parse(stdout || "[]");
		const list = Array.isArray(parsed)
			? parsed
			: ((parsed as { sandboxes?: unknown[] })?.sandboxes ?? []);
		const vms = list.filter(
			(item) => typeof (item as { name?: unknown })?.name === "string" &&
				(item as { name: string }).name.startsWith(MICROVM_PREFIX),
		).length;
		return { installed: true, ready: true, version, vms, reason: null };
	} catch (error) {
		return { installed: true, ready: false, version, vms: 0, reason: detail(error) };
	}
}

/** Remove a worktree's VM, if sbx and the VM are there; false otherwise. */
export async function removeTaskMicrovm(
	worktree: string,
	exec: Run = run,
	sbx = sbxPath(),
): Promise<boolean> {
	if (!sbx) return false;
	try {
		await exec(sbx, ["rm", "--force", microvmName(worktree)]);
		return true;
	} catch {
		// No such VM (it never ran in one), or sbx is not signed in: nothing to free.
		return false;
	}
}
