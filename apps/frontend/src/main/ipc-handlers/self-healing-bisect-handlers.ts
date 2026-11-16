/**
 * Self-healing bisect (#375): find the first commit where a CI/CD incident's
 * failing tests broke.
 *
 * The renderer names an incident and, optionally, the last commit it knows to
 * be green. Neither reaches the runner unchecked: the incident id is a short
 * token, the commit a hexadecimal id (no ref, no option, no range), and the
 * project folder was checked by `ipc-path-policy` before this handler runs.
 * The runner checks both again, resolves the commit with git, and runs the
 * stack's own test command in a temporary worktree: the renderer never gives
 * a command or a path. The runner gets `pythonRunnerEnv`, never `process.env`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	BisectProgressEvent,
	BisectRequestResult,
	BisectResult,
} from "../../shared/types/self-healing";
import { getConfiguredPythonPath } from "../python-env-manager";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const INCIDENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT_ID = /^[0-9a-fA-F]{7,40}$/;
const OUTCOMES = new Set(["good", "bad", "skip"]);
const ROLES = new Set(["bad-check", "flaky-check", "good-check", "search"]);
/** The runner's own budget is 30 minutes of test runs; git comes on top. */
const BISECT_TIMEOUT_MS = 35 * 60 * 1000;
const DEV_BACKEND = path.resolve(import.meta.dirname, "..", "..", "..", "..", "apps", "backend");

/** The runner's arguments, or the reason the request is refused. */
export function bisectArgs(
	incidentId: unknown,
	goodSha: unknown,
): { args: string[] } | { error: string } {
	if (typeof incidentId !== "string" || !INCIDENT_ID.test(incidentId)) {
		return { error: "invalid incident id" };
	}
	const args = ["bisect", "--incident-id", incidentId];
	if (goodSha === undefined || goodSha === null || goodSha === "") return { args };
	if (typeof goodSha !== "string" || !COMMIT_ID.test(goodSha)) {
		return { error: "invalid commit id" };
	}
	return { args: [...args, "--good", goodSha] };
}

/** One line of the runner, kept only when it is a well-formed tested commit. */
export function progressEvent(incidentId: string, line: Record<string, unknown>): BisectProgressEvent | null {
	if (
		line.step !== "bisect" ||
		typeof line.sha !== "string" ||
		!COMMIT_ID.test(line.sha) ||
		!OUTCOMES.has(String(line.outcome)) ||
		!ROLES.has(String(line.role)) ||
		typeof line.tested !== "number"
	) {
		return null;
	}
	return {
		incidentId,
		step: {
			sha: line.sha,
			outcome: line.outcome as BisectProgressEvent["step"]["outcome"],
			role: line.role as BisectProgressEvent["step"]["role"],
			seconds: Number(line.seconds) || 0,
			detail: String(line.detail ?? "").slice(0, 200),
			tested: line.tested,
		},
	};
}

export function backendDir(): string {
	const packaged = process.resourcesPath ? path.resolve(process.resourcesPath, "backend") : "";
	return packaged && existsSync(packaged) ? packaged : DEV_BACKEND;
}

function parseLine(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Run the self-healing runner, one callback per JSON line it prints. */
async function streamRunner(
	projectPath: string,
	args: string[],
	onLine: (line: Record<string, unknown>) => void,
): Promise<void> {
	const dir = backendDir();
	const env = await pythonRunnerEnv(dir);
	const python = getConfiguredPythonPath() || "python3";
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(
			python,
			[path.join(dir, "runners", "self_healing_runner.py"), "--project", projectPath, ...args],
			{ cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: BISECT_TIMEOUT_MS, env },
		);
		let pending = "";
		let stderr = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			const lines = (pending + chunk.toString()).split("\n");
			pending = lines.pop() as string;
			for (const text of lines) {
				const line = parseLine(text.trim());
				if (line) onLine(line);
			}
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-2000);
		});
		proc.on("close", (code: number | null) => {
			if (code === 0) resolve();
			else reject(new Error(`self-healing runner exited with code ${code}: ${stderr}`));
		});
		proc.on("error", reject);
	});
}

export function registerSelfHealingBisectHandlers(getMainWindow: () => BrowserWindow | null): void {
	ipcMain.handle(
		IPC_CHANNELS.SELF_HEALING_BISECT,
		async (_, projectPath: unknown, incidentId: unknown, goodSha?: unknown): Promise<BisectRequestResult> => {
			if (typeof projectPath !== "string" || !projectPath) {
				return { success: false, error: "invalid project" };
			}
			const parsed = bisectArgs(incidentId, goodSha);
			if ("error" in parsed) return { success: false, error: parsed.error };
			const id = incidentId as string;
			let result: BisectResult | undefined;
			try {
				await streamRunner(projectPath, parsed.args, (line) => {
					const event = progressEvent(id, line);
					if (event) {
						getMainWindow()?.webContents.send(IPC_CHANNELS.SELF_HEALING_BISECT_PROGRESS, event);
					} else if (line.step === "complete" && line.bisect && typeof line.bisect === "object") {
						result = line.bisect as BisectResult;
					}
				});
			} catch (error) {
				return { success: false, error: String(error).slice(0, 500) };
			}
			return result ? { success: true, result } : { success: false, error: "the bisect returned no result" };
		},
	);
}
