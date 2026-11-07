/**
 * One-click install of a coding-agent CLI that is missing (OpenCode, Google
 * Antigravity, pi, Gemini CLI), on Windows, macOS and Linux (WSL included).
 *
 * The tool is validated against a closed list and every command line is built
 * from WorkPilot's own constants (`AGENT_CLI_INSTALL`): nothing the renderer
 * sends reaches a command. Each CLI keeps its own sign-in: installing never
 * touches credentials.
 *
 * Order of attempts: the vendor's npm package when a native npm and a Node.js
 * recent enough for it are found, then the vendor's install script. On macOS
 * and Linux an npm global prefix the user cannot write to (system Node.js)
 * is retried into `~/.local`, whose `bin` WorkPilot already puts on PATH.
 */

import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	AGENT_CLI_INSTALL,
	type AgentCliInstallResult,
	type AgentCliStatus,
	type AgentCliTool,
	isAgentCliTool,
} from "../../shared/types/agent-cli";
import { clearNpmPrefixCache, getAugmentedEnv } from "../env-utils";
import {
	findExecutable,
	getCurrentOS,
	getPathDelimiter,
	isWindows,
} from "../platform";

const execFileAsync = promisify(execFile);

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DETAIL_MAX_CHARS = 800;

/** One way of installing a CLI, as it will run. */
export interface InstallStep {
	method: "npm" | "script";
	command: string;
	args: string[];
	/** cmd.exe is needed to run npm.cmd on Windows; args are constants. */
	shell: boolean;
}

/** What the machine offers, read before planning. */
export interface InstallHost {
	platform: "win32" | "darwin" | "linux";
	/** Absolute path of a native npm, or null. */
	npm: string | null;
	/** Node.js version as `major.minor.patch`, or null. */
	nodeVersion: string | null;
	homeDir: string;
}

/** `a >= b` for dotted versions (missing parts count as 0). */
export function versionAtLeast(version: string, minimum: string): boolean {
	const parse = (value: string) =>
		value
			.replace(/^v/, "")
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const a = parse(version);
	const b = parse(minimum);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return true;
}

/**
 * Under WSL, PATH also lists the Windows drives (`/mnt/c/...`): a Windows npm
 * found there would install a Windows binary the Linux app cannot run.
 */
export function isForeignWindowsPath(
	executable: string,
	platform: InstallHost["platform"],
): boolean {
	return platform === "linux" && /^\/mnt\/[a-z]\//i.test(executable);
}

/** The attempts for one tool on one host, best first. Pure. */
export function planAgentCliInstall(
	tool: AgentCliTool,
	host: InstallHost,
): InstallStep[] {
	const recipe = AGENT_CLI_INSTALL[tool];
	const steps: InstallStep[] = [];
	const nodeOk =
		host.nodeVersion !== null &&
		(!recipe.minNode || versionAtLeast(host.nodeVersion, recipe.minNode));

	if (recipe.npmPackage && host.npm && nodeOk) {
		steps.push({
			method: "npm",
			command: host.npm,
			args: ["install", "-g", ...(recipe.npmArgs ?? []), recipe.npmPackage],
			shell: host.platform === "win32",
		});
	}

	if (host.platform === "win32") {
		if (recipe.windowsScript) {
			steps.push({
				method: "script",
				command: "powershell.exe",
				args: [
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-Command",
					`irm ${recipe.windowsScript} | iex`,
				],
				shell: false,
			});
		}
	} else if (recipe.unixScript) {
		steps.push({
			method: "script",
			// pipefail: a failed download must fail the step, not feed an
			// empty script to the shell that then exits 0.
			command: "bash",
			args: [
				"-c",
				`set -o pipefail; curl -fsSL ${recipe.unixScript.url} | ${recipe.unixScript.shell}`,
			],
			shell: false,
		});
	}
	return steps;
}

/** The retry of an npm step into `~/.local`, for an unwritable prefix. */
export function userPrefixRetry(
	step: InstallStep,
	host: InstallHost,
): InstallStep | null {
	if (step.method !== "npm" || host.platform === "win32") return null;
	const [install, global, ...rest] = step.args;
	return {
		...step,
		args: [install, global, "--prefix", path.posix.join(host.homeDir, ".local"), ...rest],
	};
}

/** npm said it could not write its global prefix. */
export function isPermissionError(output: string): boolean {
	return /\bEACCES\b|\bEPERM\b|permission denied/i.test(output);
}

function tail(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > DETAIL_MAX_CHARS
		? `…${trimmed.slice(-DETAIL_MAX_CHARS)}`
		: trimmed;
}

/** Run one step; resolves with its exit status and combined output. */
function runStep(
	step: InstallStep,
	env: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		const finish = (ok: boolean, extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok, output: output + extra });
		};
		// The Windows shell re-splits on spaces: quote a path that holds one.
		const command =
			step.shell && /\s/.test(step.command) ? `"${step.command}"` : step.command;
		const child = spawn(command, step.args, {
			env: { ...env, CI: "1", npm_config_yes: "true" },
			shell: step.shell,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString("utf-8")).slice(-20_000);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const timer = setTimeout(() => {
			child.kill();
			finish(false, "\nTimed out after 10 minutes.");
		}, INSTALL_TIMEOUT_MS);
		child.on("error", (error) => finish(false, `\n${error.message}`));
		child.on("close", (code) => finish(code === 0));
	});
}

async function readNodeVersion(
	env: Record<string, string>,
	platform: InstallHost["platform"],
): Promise<string | null> {
	const extraPaths = (env.PATH || "").split(getPathDelimiter()).filter(Boolean);
	const node = findExecutable("node", extraPaths);
	if (!node || isForeignWindowsPath(node, platform)) return null;
	try {
		const { stdout } = await execFileAsync(node, ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
			env,
		});
		const match = /\d+\.\d+\.\d+/.exec(stdout);
		return match ? match[0] : null;
	} catch {
		return null;
	}
}

async function readHost(env: Record<string, string>): Promise<InstallHost> {
	const platform = getCurrentOS() as InstallHost["platform"];
	const extraPaths = (env.PATH || "").split(getPathDelimiter()).filter(Boolean);
	let npm = findExecutable("npm", extraPaths);
	if (npm && isForeignWindowsPath(npm, platform)) npm = null;
	return {
		platform,
		npm,
		nodeVersion: await readNodeVersion(env, platform),
		homeDir: os.homedir(),
	};
}

/**
 * Windows installers add their folder to the user PATH in the registry, which
 * a running process never sees: merge the registry PATH into ours so the
 * check that follows (and every later launch of the CLI) finds it.
 */
async function refreshWindowsPath(): Promise<void> {
	if (!isWindows()) return;
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')",
			],
			{ encoding: "utf-8", timeout: 10_000, windowsHide: true },
		);
		const current = (process.env.PATH || "").split(";").filter(Boolean);
		const known = new Set(current.map((entry) => entry.toLowerCase()));
		const added = stdout
			.trim()
			.split(";")
			.map((entry) => entry.trim())
			.filter((entry) => entry && !known.has(entry.toLowerCase()));
		if (added.length > 0) {
			process.env.PATH = [...current, ...added].join(";");
		}
	} catch {
		// The check below says whether the CLI is reachable either way.
	}
}

const running = new Set<AgentCliTool>();

/**
 * Install `tool`, then check it. `check` is the same `checkAgentCli` the
 * sidebar uses, passed in so the two modules do not import each other.
 */
export async function installAgentCli(
	tool: unknown,
	check: (tool: AgentCliTool) => Promise<AgentCliStatus>,
): Promise<AgentCliInstallResult> {
	if (!isAgentCliTool(tool)) {
		return { tool: "opencode", success: false, error: "failed", detail: "unknown tool" };
	}
	if (running.has(tool)) return { tool, success: false, error: "busy" };
	running.add(tool);
	try {
		const env = getAugmentedEnv();
		const host = await readHost(env);
		const steps = planAgentCliInstall(tool, host);
		if (steps.length === 0) return { tool, success: false, error: "node_required" };

		let lastOutput = "";
		for (const step of steps) {
			let result = await runStep(step, env);
			const retry = result.ok ? null : userPrefixRetry(step, host);
			if (retry && isPermissionError(result.output)) {
				result = await runStep(retry, env);
			}
			if (!result.ok) {
				console.warn(`[AgentCli] ${tool} install via ${step.method} failed`);
				lastOutput = result.output;
				continue;
			}
			clearNpmPrefixCache();
			await refreshWindowsPath();
			const status = await check(tool);
			if (status.installed) return { tool, success: true, method: step.method, status };
			return {
				tool,
				success: false,
				method: step.method,
				status,
				error: "not_on_path",
				detail: tail(result.output),
			};
		}
		return { tool, success: false, error: "failed", detail: tail(lastOutput) };
	} finally {
		running.delete(tool);
	}
}
