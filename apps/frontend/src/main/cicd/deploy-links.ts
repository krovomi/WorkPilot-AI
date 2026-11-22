/**
 * The services a person rolls back together (#366, lot 4).
 *
 * On the CI/CD page of a project, the person picks the other projects that
 * go back when this one does (the frontend with its backend). The links are
 * the app's own settings, in its user data folder, never a file of a
 * repository: a committed file cannot make WorkPilot roll another project
 * back. Each link names a project of the app's list by its id; one that is no
 * longer there is skipped.
 *
 * A rollback of one project goes down the links, through the projects they
 * name and theirs in turn, each once (a loop of links ends where it began).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEPLOY_LINKS_FILE = "deploy-links.json";
/** Projects one project may take back with it, and in all from one rollback. */
export const MAX_LINKS = 20;
const MAX_PROJECTS = 500;
const MAX_FILE_BYTES = 512 * 1024;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Project id → the ids of the projects rolled back with it. */
export type DeployLinks = Record<string, string[]>;

export function isProjectId(value: unknown): value is string {
	return typeof value === "string" && PROJECT_ID.test(value);
}

/** The links of a file's content, bounded; anything malformed is dropped. */
export function parseDeployLinks(raw: unknown): DeployLinks {
	const links: DeployLinks = {};
	const table =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>).links
			: undefined;
	if (!table || typeof table !== "object" || Array.isArray(table)) return links;
	for (const [id, targets] of Object.entries(table).slice(0, MAX_PROJECTS)) {
		if (!isProjectId(id) || !Array.isArray(targets)) continue;
		const valid = [...new Set(targets.filter(isProjectId))].filter((t) => t !== id);
		if (valid.length > 0) links[id] = valid.slice(0, MAX_LINKS);
	}
	return links;
}

export function readDeployLinks(dir: string): DeployLinks {
	const file = path.join(dir, DEPLOY_LINKS_FILE);
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return {};
		return parseDeployLinks(JSON.parse(fs.readFileSync(file, "utf-8")));
	} catch {
		return {};
	}
}

export function writeDeployLinks(dir: string, links: DeployLinks): void {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, DEPLOY_LINKS_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify({ version: 1, links }, null, 2), "utf-8");
	fs.renameSync(temp, file);
}

/**
 * The links with `projectId`'s replaced by `targets`: only projects of
 * `known`, never itself, each once, at most MAX_LINKS; null when `targets`
 * is not a list of ids.
 */
export function withLinks(
	links: DeployLinks,
	projectId: string,
	targets: unknown,
	known: ReadonlySet<string>,
): DeployLinks | null {
	if (!Array.isArray(targets) || targets.length > MAX_LINKS) return null;
	if (!targets.every(isProjectId)) return null;
	const kept = [...new Set(targets)].filter((t) => t !== projectId && known.has(t));
	const next = { ...links };
	if (kept.length > 0) next[projectId] = kept;
	else delete next[projectId];
	return next;
}

/**
 * The projects that go back with `root`, nearest first: those it links, then
 * those they link, each once and never `root` itself, at most MAX_LINKS.
 */
export function rollbackOrder(links: DeployLinks, root: string): string[] {
	const order: string[] = [];
	const seen = new Set([root]);
	const queue = [root];
	while (queue.length > 0 && order.length < MAX_LINKS) {
		const current = queue.shift() as string;
		for (const next of links[current] ?? []) {
			if (seen.has(next) || order.length >= MAX_LINKS) continue;
			seen.add(next);
			order.push(next);
			queue.push(next);
		}
	}
	return order;
}
