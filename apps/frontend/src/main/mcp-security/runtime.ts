/**
 * The MCP Marketplace's security services in the running app (#369): the
 * registry facts and the installed-server check kept in the app's data, the
 * install policy as `env:update` applies it, and the daily check's timer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { loadMcpCatalog } from "../../shared/mcp-catalog/install";
import { appLog } from "../app-logger";
import { parseCustomMcpServers } from "../custom-mcp-secrets";
import { offlineStrict } from "../ipc-handlers/task/split-merge-watch";
import { readProjectEnv } from "../project-env-file";
import { projectStore } from "../project-store";
import type { InstallGuardDeps } from "./install-guard";
import { InstalledWatchStore, runInstalledWatch, type WatchDeps } from "./installed-watch";
import { acceptedFindings } from "../../shared/mcp-catalog/install-policy";
import { readMcpPolicy } from "./policy-file";
import { RegistryFactsStore } from "./registry-facts";
import { type ScoreDeps, scoreCatalogEntry } from "./server-security";
import { SourceScanStore } from "./source-scan";

/** `userData/mcp-marketplace`, created when missing. */
export function marketplaceDataDir(): string {
	const dir = path.join(app.getPath("userData"), "mcp-marketplace");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return dir;
}

let factsStore: RegistryFactsStore | null = null;
let watchStore: InstalledWatchStore | null = null;
let scanStore: SourceScanStore | null = null;

/** The registry facts of the catalog's packages, cached in the app's data. */
export function securityStore(): RegistryFactsStore {
	factsStore ??= new RegistryFactsStore(path.join(marketplaceDataDir(), "security-facts.json"));
	return factsStore;
}

/** The static scans of the catalog's packages, one per version (lot 3). */
export function sourceScanStore(): SourceScanStore {
	scanStore ??= new SourceScanStore(path.join(marketplaceDataDir(), "code-scans.json"));
	return scanStore;
}

/** What a score needs: facts, scans, offline mode, the policy's accepted findings. */
export function scoreDeps(): ScoreDeps {
	return {
		store: securityStore(),
		offline: offlineStrict,
		scan: sourceScanStore(),
		accepted: (projectPath) => acceptedFindings(readMcpPolicy(projectPath)),
	};
}

/** The last reading and the alerts of each installed catalog server. */
export function installedWatchStore(): InstalledWatchStore {
	watchStore ??= new InstalledWatchStore(path.join(marketplaceDataDir(), "installed-watch.json"));
	return watchStore;
}

/** A registered project's custom MCP servers, as its `.workpilot/.env` holds them. */
export function projectMcpServers(projectId: string): unknown[] {
	const project = projectStore.getProject(projectId);
	return project ? parseCustomMcpServers(readProjectEnv(project).CUSTOM_MCP_SERVERS) : [];
}

export function watchDeps(): WatchDeps {
	return {
		projects: () => projectStore.getProjects().map((p) => ({ id: p.id, path: p.path })),
		installed: (project) => projectMcpServers(project.id),
		offline: offlineStrict,
		catalog: loadMcpCatalog,
		facts: securityStore(),
		scan: sourceScanStore(),
		watch: installedWatchStore(),
		warn: (message) => appLog.warn(message),
	};
}

export function installGuardDeps(): InstallGuardDeps {
	return {
		readPolicy: readMcpPolicy,
		catalog: loadMcpCatalog,
		score: async (entry, projectPath) =>
			(await scoreCatalogEntry(entry, projectPath, scoreDeps())).score,
	};
}

const FIRST_RUN_MS = 2 * 60_000;
const EVERY_MS = 60 * 60_000;

let first: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Starts the daily check: a first look a little after start-up, then every
 * hour, each one doing nothing while the last check is under a day old.
 */
export function startMcpInstalledWatch(deps: () => WatchDeps = watchDeps): void {
	if (timer) return;
	const look = async () => {
		if (running) return;
		running = true;
		try {
			const raised = await runInstalledWatch(deps());
			if (raised) appLog.info(`[MCP watch] ${raised} new alert(s) on installed servers`);
		} catch (error) {
			appLog.warn(
				`[MCP watch] The check failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			running = false;
		}
	};
	first = setTimeout(() => void look(), FIRST_RUN_MS);
	timer = setInterval(() => void look(), EVERY_MS);
	first.unref?.();
	timer.unref?.();
}

export function stopMcpInstalledWatch(): void {
	if (first) clearTimeout(first);
	if (timer) clearInterval(timer);
	first = null;
	timer = null;
}
