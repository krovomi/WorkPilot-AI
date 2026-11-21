/**
 * The daily check of installed MCP servers (#369, lot 2).
 *
 * Once a day at most, in the background after start-up, the main process
 * reads again the registry facts of each catalog server a registered project
 * has installed — with the same closed hosts, bounds and one-day cache as the
 * score (`registry-facts.ts`) — and compares them with the last reading it
 * kept. What got worse becomes an alert: a new advisory for the version it
 * runs, a maintainer who appeared, the package deprecated or yanked, the
 * score fallen below 50. An alert is raised once (its id is stable) and stays
 * until the person acknowledges it.
 *
 * Only catalog servers are read, as the catalog defines them
 * (`matchCatalogServer`): the package name comes from the catalog shipped
 * with the app, never from the renderer or a project file. A project in
 * strict offline mode is not looked at. The first reading of a server sets
 * its baseline and raises nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { matchCatalogServer } from "../../shared/mcp-catalog/catalog-match";
import { POLICY_SERVER_ID } from "../../shared/mcp-catalog/install-policy";
import { scoreServer, securityLevel } from "../../shared/mcp-catalog/security-score";
import type {
	McpMarketplaceFailure,
	McpMarketplaceServer,
} from "../../shared/types/mcp-marketplace";
import type {
	McpInstalledServerWatch,
	McpInstalledWatchView,
	McpRegistryFacts,
	McpWatchAlert,
} from "../../shared/types/mcp-security";
import {
	CACHE_TTL_MS,
	type PackageRef,
	packageOf,
	type RegistryFactsStore,
} from "./registry-facts";

const MAX_ALERTS = 50;

/** What the last reading of a server said, to compare the next one with. */
export interface WatchBaseline {
	version?: string;
	/** Advisory ids; absent while OSV has never answered. */
	vulnerabilities?: string[];
	maintainers: string[];
	deprecated: boolean;
	score: number;
	checkedAt: string;
}

interface WatchedServer {
	baseline?: WatchBaseline;
	alerts: McpWatchAlert[];
}

interface WatchFile {
	lastRun?: string;
	servers: Record<string, WatchedServer>;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export class InstalledWatchStore {
	constructor(private readonly file: string) {}

	read(): WatchFile {
		try {
			const raw = record(JSON.parse(fs.readFileSync(this.file, "utf-8")));
			return {
				...(typeof raw.lastRun === "string" ? { lastRun: raw.lastRun } : {}),
				servers: record(raw.servers) as Record<string, WatchedServer>,
			};
		} catch {
			return { servers: {} };
		}
	}

	write(data: WatchFile): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(data, null, 2), "utf-8");
	}

	/** Marks every alert of `serverId` acknowledged; false when it has none. */
	acknowledge(serverId: string, now: number): boolean {
		const data = this.read();
		const server = data.servers[serverId];
		const open = (server?.alerts ?? []).filter((a) => !a.acknowledgedAt);
		if (!open.length) return false;
		const at = new Date(now).toISOString();
		for (const alert of open) alert.acknowledgedAt = at;
		this.write(data);
		return true;
	}
}

/** The baseline the reading `facts` (scored `score`) gives, on top of `previous`. */
export function baselineOf(
	facts: McpRegistryFacts,
	score: number,
	previous?: WatchBaseline,
): WatchBaseline {
	const vulnerabilities = facts.vulnerabilitiesUnknown
		? previous?.vulnerabilities
		: facts.vulnerabilities.map((v) => v.id);
	return {
		...(facts.version ? { version: facts.version } : {}),
		...(vulnerabilities ? { vulnerabilities } : {}),
		maintainers: [...facts.maintainers],
		deprecated: Boolean(facts.deprecated),
		score,
		checkedAt: facts.checkedAt,
	};
}

/** What got worse from `previous` to the reading `facts`, scored `score`. */
export function worsened(
	previous: WatchBaseline,
	facts: McpRegistryFacts,
	score: number,
	detectedAt: string,
): McpWatchAlert[] {
	const alerts: McpWatchAlert[] = [];
	const add = (id: string, kind: McpWatchAlert["kind"], values: McpWatchAlert["values"]) =>
		alerts.push({ id, kind, values, detectedAt });

	if (previous.vulnerabilities && !facts.vulnerabilitiesUnknown) {
		const known = new Set(previous.vulnerabilities);
		for (const vuln of facts.vulnerabilities) {
			if (!known.has(vuln.id)) {
				add(`vuln:${vuln.id}`, "newVulnerability", {
					id: vuln.id,
					summary: vuln.summary,
					version: facts.version ?? "",
				});
			}
		}
	}
	if (previous.maintainers.length) {
		const known = new Set(previous.maintainers);
		const added = facts.maintainers.filter((name) => !known.has(name));
		if (added.length) {
			add(`maintainers:${added.join(",")}`, "maintainerAdded", { names: added.join(", ") });
		}
	}
	if (!previous.deprecated && facts.deprecated) {
		add(`deprecated:${facts.version ?? ""}`, "deprecated", { version: facts.version ?? "" });
	}
	if (securityLevel(previous.score) !== "low" && securityLevel(score) === "low") {
		add(`low:${facts.checkedAt}`, "lowScore", { score, previous: previous.score });
	}
	return alerts;
}

export interface WatchProject {
	id: string;
	path: string;
}

export interface WatchDeps {
	projects: () => WatchProject[];
	/** The project's custom MCP servers, read from its `.workpilot/.env`. */
	installed: (project: WatchProject) => unknown[];
	offline: (projectPath: string) => boolean;
	catalog: () => McpMarketplaceServer[];
	facts: RegistryFactsStore;
	watch: InstalledWatchStore;
	now?: () => number;
	warn?: (message: string) => void;
}

/** The catalog servers to read: installed by a project not in strict offline mode. */
function serversToRead(deps: WatchDeps): [McpMarketplaceServer, PackageRef][] {
	const catalog = deps.catalog();
	const found = new Map<string, [McpMarketplaceServer, PackageRef]>();
	for (const project of deps.projects()) {
		if (!project.path || deps.offline(project.path)) continue;
		for (const server of deps.installed(project)) {
			const entry = matchCatalogServer(server, catalog);
			const ref = entry && packageOf(entry);
			if (entry && ref) found.set(entry.id, [entry, ref]);
		}
	}
	return [...found.values()];
}

/**
 * One daily check; the number of new alerts, or null when the last check is
 * under a day old.
 */
export async function runInstalledWatch(deps: WatchDeps): Promise<number | null> {
	const now = deps.now ?? Date.now;
	const start = now();
	const last = deps.watch.read().lastRun;
	if (last && start - Date.parse(last) < CACHE_TTL_MS) return null;

	let raised = 0;
	for (const [entry, ref] of serversToRead(deps)) {
		let facts: McpRegistryFacts;
		try {
			facts = await deps.facts.facts(entry.id, ref);
		} catch (error) {
			deps.warn?.(
				`[MCP watch] ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		const score = scoreServer(entry, { facts, now: start }).score;
		const data = deps.watch.read();
		const server = data.servers[entry.id] ?? { alerts: [] };
		const known = new Set(server.alerts.map((a) => a.id));
		const fresh = server.baseline
			? worsened(server.baseline, facts, score, new Date(start).toISOString()).filter(
					(a) => !known.has(a.id),
				)
			: [];
		raised += fresh.length;
		data.servers[entry.id] = {
			baseline: baselineOf(facts, score, server.baseline),
			alerts: [...server.alerts, ...fresh].slice(-MAX_ALERTS),
		};
		deps.watch.write(data);
	}
	const data = deps.watch.read();
	data.lastRun = new Date(start).toISOString();
	deps.watch.write(data);
	return raised;
}

/** What the installed list shows of `project`'s servers. */
export function installedWatchView(
	project: WatchProject,
	deps: Pick<WatchDeps, "installed" | "offline" | "catalog" | "watch">,
): McpInstalledWatchView {
	const data = deps.watch.read();
	const catalog = deps.catalog();
	const offline = deps.offline(project.path);
	const servers: McpInstalledServerWatch[] = [];
	for (const server of deps.installed(project)) {
		const id = record(server).id;
		if (typeof id !== "string") continue;
		const entry = matchCatalogServer(server, catalog);
		if (!entry) {
			servers.push({ serverId: id, status: "unverifiable", alerts: [] });
			continue;
		}
		const watched = data.servers[entry.id];
		const alerts = (watched?.alerts ?? []).filter((a) => !a.acknowledgedAt);
		const status = !packageOf(entry)
			? "remote"
			: offline
				? "offline"
				: watched?.baseline
					? "watched"
					: "pending";
		servers.push({
			serverId: id,
			status,
			alerts,
			...(watched?.baseline ? { checkedAt: watched.baseline.checkedAt } : {}),
		});
	}
	return { ...(data.lastRun ? { lastRun: data.lastRun } : {}), servers };
}

/** A watch request refused for a reason the renderer words (`code`). */
export class McpWatchRequestError extends Error {
	constructor(readonly code: McpMarketplaceFailure) {
		super(code);
	}
}

/** The project id of a view request, checked (S6). */
export function parseWatchRequest(raw: unknown): { projectId: string } {
	const projectId = record(raw).projectId;
	if (typeof projectId !== "string" || !projectId) {
		throw new McpWatchRequestError("watchProjectRequired");
	}
	return { projectId };
}

/** The server id of an acknowledgement, checked (S6). */
export function parseAcknowledgeRequest(raw: unknown): { serverId: string } {
	const serverId = record(raw).serverId;
	if (typeof serverId !== "string" || !POLICY_SERVER_ID.test(serverId)) {
		throw new McpWatchRequestError("watchServerRequired");
	}
	return { serverId };
}
