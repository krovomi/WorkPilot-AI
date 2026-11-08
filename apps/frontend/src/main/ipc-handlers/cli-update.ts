/**
 * One-click update of an installed CLI of the « Outils CLI » panel (OpenCode,
 * Antigravity, pi, Gemini CLI, hermes-agent), on Windows, macOS and Linux
 * (WSL included). Claude Code, Copilot and Codex keep their own updaters.
 *
 * Two questions, two functions:
 * - `checkCliUpdate`: which version is installed, which is the latest the
 *   vendor published (npm registry or GitHub releases, through the shared
 *   `latest-version-source`, so an offline machine costs one log line), and
 *   whether the first is older.
 * - `updateCli`: update the copy the app really runs, with whoever owns it.
 *   Installing with another channel would succeed, write a second copy
 *   elsewhere and leave the one on PATH old. So: the package manager that owns
 *   it (npm, pnpm, Homebrew), else the CLI's own updater, else, for a copy no
 *   package manager owns, the vendor's install script again.
 *
 * The tool is validated against a closed list and every command line is built
 * from WorkPilot's constants (`CLI_UPDATE`, `AGENT_CLI_INSTALL`) and from the
 * executable PATH resolves to: nothing the renderer sends reaches a command.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentCliStatus, AgentCliTool } from "../../shared/types/agent-cli";
import {
	CLI_UPDATE,
	type CliUpdateResult,
	type CliUpdateStatus,
	isUpdatableCliTool,
	type UpdatableCliTool,
} from "../../shared/types/cli-update";
import { clearNpmPrefixCache, getAugmentedEnv } from "../env-utils";
import {
	findExecutable,
	getCurrentOS,
	getPathDelimiter,
	isSecurePath,
	requiresShell,
} from "../platform";
import {
	createLatestVersionSource,
	fetchJsonWithRetry,
	type LatestVersionSource,
	npmVersionOf,
} from "../utils/latest-version-source";
import {
	busyCliTools,
	type InstallHost,
	isForeignWindowsPath,
	planAgentCliInstall,
	readHost,
	refreshWindowsPath,
	runStep,
	tail,
	versionAtLeast,
} from "./agent-cli-install";

const execFileAsync = promisify(execFile);

type Platform = InstallHost["platform"];

/** The agent CLIs' own check, passed in so the modules do not import each other. */
export type AgentCliCheck = (tool: AgentCliTool) => Promise<AgentCliStatus>;

const LATEST_TTL_MS = 60 * 60 * 1000;
const USER_AGENT = { "User-Agent": "WorkPilot-AI/1.0" };

// ---------------------------------------------------------------------------
// Latest published version
// ---------------------------------------------------------------------------

/**
 * A GitHub release tag that names a release: `v0.23.0`. A canary
 * (`v0.23.0+canary.20261107`) or an old calendar tag (`v2026.9.24`) is not one.
 */
export function releaseVersionOf(tag: unknown): string {
	const match =
		typeof tag === "string" ? /^v?(\d{1,3}\.\d{1,4}\.\d{1,4})$/.exec(tag.trim()) : null;
	if (!match) throw new TypeError("no release version in the GitHub answer");
	return match[1];
}

const latestSources = new Map<UpdatableCliTool, LatestVersionSource<string>>();

/** The lookup of `tool`'s latest release, or undefined when none is published. */
function latestSource(tool: UpdatableCliTool): LatestVersionSource<string> | undefined {
	const where = CLI_UPDATE[tool].latest;
	if (!where) return undefined;
	let source = latestSources.get(tool);
	if (!source) {
		source = createLatestVersionSource({
			label: `[CLI update] ${tool}`,
			what: "npm" in where ? "the latest version on npm" : "the latest GitHub release",
			ttlMs: LATEST_TTL_MS,
			load: async () =>
				"npm" in where
					? npmVersionOf(
							await fetchJsonWithRetry(
								`https://registry.npmjs.org/${where.npm}/latest`,
								USER_AGENT,
							),
						)
					: releaseVersionOf(
							(
								(await fetchJsonWithRetry(
									`https://api.github.com/repos/${where.github}/releases/latest`,
									{ ...USER_AGENT, Accept: "application/vnd.github+json" },
								)) as { tag_name?: unknown } | null
							)?.tag_name,
						),
		});
		latestSources.set(tool, source);
	}
	return source;
}

/** `installed` is older than `latest`; false when either is unknown. */
export function isOlder(installed: string | undefined, latest: string | undefined): boolean {
	return Boolean(installed && latest && !versionAtLeast(installed, latest));
}

// ---------------------------------------------------------------------------
// Installed version
// ---------------------------------------------------------------------------

/**
 * The release `hermes --version` names: `Hermes Agent v0.23.0 (2026.9.24)`.
 * Anchored on the product name, like the backend's `hermes/version.py`: the
 * same output has a `Python: 3.12.3` line, and a checkout without its tags
 * prints `vgit.<sha>`, which is no release at all.
 */
export function parseHermesVersion(output: string): string | undefined {
	const match = /hermes agent v(\d{1,3})\.(\d{1,4})\.(\d{1,4})\b/i.exec(output);
	return match ? match.slice(1, 4).join(".") : undefined;
}

function pathEntries(env: Record<string, string>): string[] {
	return (env.PATH || "").split(getPathDelimiter()).filter(Boolean);
}

/** An executable that runs without a shell: what `--version` and `update` may run. */
function runsWithoutShell(executable: string): boolean {
	return !requiresShell(executable) && isSecurePath(executable);
}

async function checkHermes(): Promise<{ installed: boolean; version?: string }> {
	const env = getAugmentedEnv();
	const executable = findExecutable(CLI_UPDATE.hermes.executable, pathEntries(env));
	if (!executable) return { installed: false };
	if (!runsWithoutShell(executable)) return { installed: true };
	try {
		const { stdout } = await execFileAsync(executable, ["--version"], {
			encoding: "utf-8",
			timeout: 10_000,
			windowsHide: true,
			env: { ...env, NO_COLOR: "1" },
		});
		return { installed: true, version: parseHermesVersion(stdout) };
	} catch {
		return { installed: true };
	}
}

/** Installed version against the latest published one. Never throws. */
export async function checkCliUpdate(
	tool: unknown,
	checkAgentCli: AgentCliCheck,
): Promise<CliUpdateStatus> {
	if (!isUpdatableCliTool(tool)) {
		return { tool: "opencode", installed: false, isOutdated: false };
	}
	let installed = false;
	let version: string | undefined;
	try {
		const local = tool === "hermes" ? await checkHermes() : await checkAgentCli(tool);
		installed = local.installed;
		version = local.version;
	} catch {
		// Reported as not installed: the panel's own check says why.
	}
	if (!installed) return { tool, installed, isOutdated: false };
	const latest = await latestSource(tool)?.get();
	return { tool, installed, version, latest, isOutdated: isOlder(version, latest) };
}

// ---------------------------------------------------------------------------
// Who owns the installed copy
// ---------------------------------------------------------------------------

export type InstallOwner =
	| { kind: "npm"; prefix?: string }
	| { kind: "pnpm" }
	| { kind: "brew" }
	| { kind: "other" };

/** A path that may reach cmd.exe as an argument: no shell metacharacter. */
function isPlainPath(value: string): boolean {
	return !/["&|<>^%!\r\n]/.test(value);
}

/**
 * Who installed the executable PATH resolves to, judged from its real path.
 * `npmShimDir`: on Windows, the folder of a `.cmd` launcher that has a
 * `node_modules` beside it (npm's global prefix there).
 */
export function detectInstallOwner(
	executable: string,
	realPath: string,
	platform: Platform,
	npmShimDir?: string,
): InstallOwner {
	const both = `${executable}\n${realPath}`;
	if (/pnpm/i.test(both)) return { kind: "pnpm" };
	if (platform !== "win32" && /\/Cellar\/|^\/opt\/homebrew\/|\/\.linuxbrew\//.test(both)) {
		return { kind: "brew" };
	}
	const separator = platform === "win32" ? /[\\/]/ : /\//;
	const segments = realPath.split(separator);
	const nodeModules = segments.lastIndexOf("node_modules");
	if (nodeModules > 0) {
		const join = (parts: string[]) => parts.join(platform === "win32" ? "\\" : "/");
		// Unix: <prefix>/lib/node_modules, Windows: <prefix>\node_modules. Any
		// other layout is left to npm's default prefix rather than guessed.
		const parent = segments.slice(0, nodeModules);
		let prefix: string | undefined;
		if (platform === "win32") prefix = join(parent);
		else if (parent.at(-1) === "lib") prefix = join(parent.slice(0, -1));
		return { kind: "npm", prefix: prefix && isPlainPath(prefix) ? prefix : undefined };
	}
	if (npmShimDir) {
		return { kind: "npm", prefix: isPlainPath(npmShimDir) ? npmShimDir : undefined };
	}
	return { kind: "other" };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface UpdateStep {
	method: NonNullable<CliUpdateResult["method"]>;
	command: string;
	args: string[];
	/** cmd.exe runs npm.cmd and pnpm.cmd on Windows; args are constants or plain paths. */
	shell: boolean;
}

export interface UpdateHost extends InstallHost {
	pnpm: string | null;
	brew: string | null;
}

/** cmd.exe splits on spaces: quote an argument that holds one. */
function shellArg(value: string, shell: boolean): string {
	return shell && /\s/.test(value) ? `"${value}"` : value;
}

/** The attempts for one installed CLI, best first. Pure. */
export function planCliUpdate(
	tool: UpdatableCliTool,
	host: UpdateHost,
	owner: InstallOwner,
	executable: string,
): UpdateStep[] {
	const recipe = CLI_UPDATE[tool];
	const steps: UpdateStep[] = [];
	const onWindows = host.platform === "win32";

	if (owner.kind === "npm" && recipe.npmPackage && host.npm) {
		const prefix = owner.prefix ? ["--prefix", shellArg(owner.prefix, onWindows)] : [];
		steps.push({
			method: "npm",
			command: host.npm,
			args: ["install", "-g", ...prefix, ...(recipe.npmArgs ?? []), recipe.npmPackage],
			shell: onWindows,
		});
	}
	if (owner.kind === "pnpm" && recipe.npmPackage && host.pnpm) {
		steps.push({
			method: "npm",
			command: host.pnpm,
			args: ["add", "-g", recipe.npmPackage],
			shell: onWindows,
		});
	}
	if (owner.kind === "brew" && recipe.brewFormula && host.brew) {
		steps.push({
			method: "brew",
			command: host.brew,
			args: ["upgrade", recipe.brewFormula],
			shell: false,
		});
	}
	if (recipe.selfUpdate && runsWithoutShell(executable)) {
		steps.push({ method: "self", command: executable, args: [...recipe.selfUpdate], shell: false });
	}
	// The vendor script installs where it always does: only right for a copy
	// no package manager owns, else it would add a second one beside it.
	if (owner.kind === "other" && tool !== "hermes") {
		for (const step of planAgentCliInstall(tool, host)) {
			if (step.method === "script") steps.push(step);
		}
	}
	return steps;
}

async function readUpdateHost(env: Record<string, string>): Promise<UpdateHost> {
	const host = await readHost(env);
	const find = (name: string) => {
		const found = findExecutable(name, pathEntries(env));
		return found && !isForeignWindowsPath(found, host.platform) ? found : null;
	};
	return { ...host, pnpm: find("pnpm"), brew: host.platform === "win32" ? null : find("brew") };
}

async function readOwner(executable: string, platform: Platform): Promise<InstallOwner> {
	const realPath = await fs.realpath(executable).catch(() => executable);
	const dir = path.dirname(executable);
	const npmShimDir =
		platform === "win32" && /\.(cmd|ps1)$/i.test(executable) && existsSync(path.join(dir, "node_modules"))
			? dir
			: undefined;
	return detectInstallOwner(executable, realPath, platform, npmShimDir);
}

// ---------------------------------------------------------------------------
// The update
// ---------------------------------------------------------------------------

/** Update `tool` with whoever owns it, then check it again. */
export async function updateCli(
	tool: unknown,
	checkAgentCli: AgentCliCheck,
): Promise<CliUpdateResult> {
	if (!isUpdatableCliTool(tool)) {
		return { tool: "opencode", success: false, error: "failed", detail: "unknown tool" };
	}
	if (busyCliTools.has(tool)) return { tool, success: false, error: "busy" };
	busyCliTools.add(tool);
	try {
		const env = getAugmentedEnv();
		const executable = findExecutable(CLI_UPDATE[tool].executable, pathEntries(env));
		if (!executable) return { tool, success: false, error: "not_installed" };
		const platform = getCurrentOS() as Platform;
		const [host, owner] = await Promise.all([
			readUpdateHost(env),
			readOwner(executable, platform),
		]);
		const steps = planCliUpdate(tool, host, owner, executable);
		if (steps.length === 0) {
			return { tool, success: false, error: "no_method", detail: executable };
		}

		let lastOutput = "";
		for (const step of steps) {
			const result = await runStep(step, env);
			if (!result.ok) {
				console.warn(`[CLI update] ${tool} update via ${step.method} failed`);
				lastOutput = result.output;
				continue;
			}
			clearNpmPrefixCache();
			await refreshWindowsPath();
			const status = await checkCliUpdate(tool, checkAgentCli);
			if (status.isOutdated) {
				// Exit 0 proves nothing about the copy the app runs: say so.
				return {
					tool,
					success: false,
					method: step.method,
					status,
					error: "still_outdated",
					detail: tail(`${executable}\n${result.output}`),
				};
			}
			return { tool, success: true, method: step.method, status };
		}
		return { tool, success: false, error: "failed", detail: tail(lastOutput) };
	} finally {
		busyCliTools.delete(tool);
	}
}
