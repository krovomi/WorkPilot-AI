/**
 * REA in the sidebar « Outils CLI »: is the pinned release installed, and a
 * one-click install of exactly that release (`npm install -g rea-agents@<pin>`).
 *
 * The backend runs REA through `apps/backend/rea/` (installed release first,
 * else npx); the badge only makes the installed path available. Nothing the
 * renderer sends reaches a command: both handlers take no argument and the
 * npm command line is WorkPilot's own constants. The version is read from the
 * `package.json` behind `rea`, never by running it: on Windows `rea.cmd` only
 * runs through cmd.exe, and the same reading as the backend's `installed_entry`
 * keeps the badge and the runner in agreement.
 *
 * The Node.js is the PATH's when REA accepts it, else the newest release a
 * version manager already installed that it accepts (`../node-installs`), as
 * the backend's `locate` picks it: under WSL the app inherits nvm's default
 * alias, not the version the user's terminal switched to. The pinned release
 * then installs into that Node.js's own prefix, with its own npm.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	nodeSatisfies,
	REA_PIN,
	REA_SPEC,
	type ReaInstallResult,
	type ReaStatus,
} from "../../shared/types/rea";
import { clearNpmPrefixCache, getAugmentedEnv } from "../env-utils";
import { managedNodeInstalls, type NodeInstall, npmCliBeside } from "../node-installs";
import { findExecutable, getPathDelimiter, isWindows } from "../platform";
import {
	busyCliTools,
	type InstallHost,
	type InstallStep,
	isForeignWindowsPath,
	isPermissionError,
	readHost,
	refreshWindowsPath,
	runStep,
	tail,
	userPrefixRetry,
} from "./agent-cli-install";

const BUSY_KEY = "rea";

const execFileAsync = promisify(execFile);

/** A Node.js that is not the PATH's, found where a version manager keeps it. */
export interface ReaNode {
	path: string;
	version: string;
	manager: string;
}

/** `node --version` as `major.minor.patch`, or null. */
async function versionOf(node: string, env: Record<string, string>): Promise<string | null> {
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

/**
 * The managed release to run REA with when the PATH's Node.js is missing or
 * too old, or undefined (the PATH's Node.js stands, or nothing better exists).
 * Newest first; a directory name is a hint, the binary's answer decides.
 */
export async function pickManagedNode(
	host: InstallHost,
	env: Record<string, string>,
	installs: NodeInstall[] = managedNodeInstalls(),
	readVersion: (node: string) => Promise<string | null> = (node) => versionOf(node, env),
): Promise<ReaNode | undefined> {
	if (host.nodeVersion && nodeSatisfies(host.nodeVersion, REA_PIN.node)) return undefined;
	for (const install of installs) {
		if (!nodeSatisfies(install.version.join("."), REA_PIN.node)) continue;
		if (isForeignWindowsPath(install.path, host.platform)) continue;
		const version = await readVersion(install.path);
		if (version && nodeSatisfies(version, REA_PIN.node)) {
			return { path: install.path, version, manager: install.manager };
		}
	}
	return undefined;
}

/** The `rea-agents` version of a package directory, or undefined. */
function packageVersion(packageDir: string): string | undefined {
	try {
		const data = JSON.parse(
			fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"),
		) as Record<string, unknown>;
		return data.name === REA_PIN.package && typeof data.version === "string"
			? data.version.slice(0, 40)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * The version of the `rea-agents` package a `rea` launcher leads to: npm
 * links `bin/rea` to `…/rea-agents/scripts/rea.mjs` on macOS and Linux and
 * writes `rea.cmd` beside `node_modules/` on Windows.
 */
export function installedReaVersion(launcher: string): string | undefined {
	const candidates: string[] = [];
	try {
		candidates.push(fs.realpathSync(launcher));
	} catch {
		// A dangling link: the Windows layout below may still answer.
	}
	candidates.push(
		path.join(path.dirname(launcher), "node_modules", REA_PIN.package, "scripts", "rea.mjs"),
	);
	for (const entry of candidates) {
		if (path.basename(entry) !== "rea.mjs") continue;
		try {
			if (!fs.statSync(entry).isFile()) continue;
		} catch {
			continue;
		}
		const version = packageVersion(path.dirname(path.dirname(entry)));
		if (version) return version;
	}
	return undefined;
}

/** The `rea` launcher npm writes beside a Node.js for a global install. */
function launcherBeside(node: string): string {
	return path.join(path.dirname(node), isWindows() ? "rea.cmd" : "rea");
}

/**
 * The check, on a host already read. Pure but for the PATH lookup and the
 * disk. `node` is a managed release picked by `pickManagedNode`.
 */
export function readReaStatus(
	host: InstallHost,
	env: Record<string, string>,
	node?: ReaNode,
): ReaStatus {
	const base = { pinned: REA_PIN.version };
	const nodeVersion = node?.version ?? host.nodeVersion;
	if (!nodeVersion) return { ...base, state: "node_missing" };
	if (!nodeSatisfies(nodeVersion, REA_PIN.node)) {
		return { ...base, state: "node_too_old", nodeVersion };
	}
	const found = { ...base, nodeVersion, ...(node ? { nodeManager: node.manager } : {}) };
	const extraPaths = (env.PATH || "").split(getPathDelimiter()).filter(Boolean);
	const onPath = findExecutable("rea", extraPaths);
	const launchers = [
		...(onPath && !isForeignWindowsPath(onPath, host.platform) ? [onPath] : []),
		...(node ? [launcherBeside(node.path)] : []),
	];
	let installedVersion: string | undefined;
	for (const launcher of launchers) {
		const version = installedReaVersion(launcher);
		if (version === REA_PIN.version) {
			return { ...found, state: "ready", installedVersion: version };
		}
		installedVersion ??= version;
	}
	if (!installedVersion && !launchers.includes(onPath ?? "")) {
		return { ...found, state: "absent" };
	}
	return {
		...found,
		state: "other_version",
		...(installedVersion ? { installedVersion } : {}),
	};
}

export async function checkRea(): Promise<ReaStatus> {
	try {
		const env = getAugmentedEnv();
		const host = await readHost(env);
		return readReaStatus(host, env, await pickManagedNode(host, env));
	} catch (error) {
		return {
			pinned: REA_PIN.version,
			state: "absent",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * The npm step, or null when this host cannot run it. `--ignore-scripts`:
 * the static readers need no install script, and none of REA's dependencies
 * gets to run code at install time. A managed release installs with its own
 * npm (`node npm-cli.js`, no shell) into its own prefix.
 */
export function planReaInstall(host: InstallHost, node?: ReaNode): InstallStep | null {
	const args = ["install", "-g", "--ignore-scripts", REA_SPEC];
	if (node) {
		const npmCli = npmCliBeside(node.path);
		return npmCli
			? { method: "npm", command: node.path, args: [npmCli, ...args], shell: false }
			: null;
	}
	if (!host.npm || !host.nodeVersion || !nodeSatisfies(host.nodeVersion, REA_PIN.node)) {
		return null;
	}
	return {
		method: "npm",
		command: host.npm,
		args,
		shell: host.platform === "win32",
	};
}

/** Install the pinned release (or replace another version), then check it. */
export async function installRea(
	check: () => Promise<ReaStatus> = checkRea,
): Promise<ReaInstallResult> {
	if (busyCliTools.has(BUSY_KEY)) return { success: false, error: "busy" };
	busyCliTools.add(BUSY_KEY);
	try {
		const env = getAugmentedEnv();
		const host = await readHost(env);
		const node = await pickManagedNode(host, env);
		const step = planReaInstall(host, node);
		if (!step) return { success: false, error: "node_required" };
		let result = await runStep(step, env);
		// A version manager's prefix is the user's own: no ~/.local retry.
		const retry = result.ok || node ? null : userPrefixRetry(step, host);
		if (retry && isPermissionError(result.output)) result = await runStep(retry, env);
		if (!result.ok) {
			console.warn("[REA] npm install of the pinned release failed");
			return { success: false, error: "failed", detail: tail(result.output) };
		}
		clearNpmPrefixCache();
		await refreshWindowsPath();
		const status = await check();
		if (status.state === "ready") return { success: true, status };
		return { success: false, status, error: "not_on_path", detail: tail(result.output) };
	} finally {
		busyCliTools.delete(BUSY_KEY);
	}
}

export function registerReaHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.REA_CHECK, () => checkRea());
	ipcMain.handle(IPC_CHANNELS.REA_INSTALL, () => installRea());
}
