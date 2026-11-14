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
 */

import fs from "node:fs";
import path from "node:path";
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
import { findExecutable, getPathDelimiter } from "../platform";
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

/** The check, on a host already read. Pure but for the PATH lookup and the disk. */
export function readReaStatus(host: InstallHost, env: Record<string, string>): ReaStatus {
	const base = { pinned: REA_PIN.version };
	if (!host.nodeVersion) return { ...base, state: "node_missing" };
	const nodeVersion = host.nodeVersion;
	if (!nodeSatisfies(nodeVersion, REA_PIN.node)) {
		return { ...base, state: "node_too_old", nodeVersion };
	}
	const extraPaths = (env.PATH || "").split(getPathDelimiter()).filter(Boolean);
	const launcher = findExecutable("rea", extraPaths);
	if (!launcher || isForeignWindowsPath(launcher, host.platform)) {
		return { ...base, state: "absent", nodeVersion };
	}
	const installedVersion = installedReaVersion(launcher);
	return {
		...base,
		state: installedVersion === REA_PIN.version ? "ready" : "other_version",
		nodeVersion,
		...(installedVersion ? { installedVersion } : {}),
	};
}

export async function checkRea(): Promise<ReaStatus> {
	try {
		const env = getAugmentedEnv();
		return readReaStatus(await readHost(env), env);
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
 * gets to run code at install time.
 */
export function planReaInstall(host: InstallHost): InstallStep | null {
	if (!host.npm || !host.nodeVersion || !nodeSatisfies(host.nodeVersion, REA_PIN.node)) {
		return null;
	}
	return {
		method: "npm",
		command: host.npm,
		args: ["install", "-g", "--ignore-scripts", REA_SPEC],
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
		const step = planReaInstall(host);
		if (!step) return { success: false, error: "node_required" };
		let result = await runStep(step, env);
		const retry = result.ok ? null : userPrefixRetry(step, host);
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
