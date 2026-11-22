/**
 * The coordinated rollback of linked services (#366, lot 4).
 *
 * When a watched run of a project rolls back (by itself or because a person
 * asked), each project linked to it in the app (`deploy-links.ts`) goes back
 * too, one after the other, nearest first: the main runs
 * `deploy_watch_runner.py --action rollback-linked` in that project, with
 * that project's own CI/CD settings, and the moment the failed run goes back
 * to (when its last good run was created). The runner decides what to do in
 * each project (`apps/backend/deploy_watch/linked.py`).
 *
 * What became of each one is written next to the failed run's watch, in
 * `.workpilot/deploy_watches/<run id>.linked.json`, and read back bounded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "../../shared/types";
import type { DeployLinkedRollback, DeployLinkedStatus } from "../../shared/types/deploy-watch";
import { isoTime, RUN_ID, readJsonFile } from "./deploy-watch";
import { MAX_LINKS } from "./deploy-links";

const STATUSES: readonly DeployLinkedStatus[] = [
	"started",
	"failed",
	"blocked_migrations",
	"manual",
	"not_deployed_since",
	"missing",
	"error",
];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_MIGRATIONS = 20;

/** Runs the deploy-watch runner in a project with its CI/CD settings. */
export type LinkedRunner = (
	project: Project,
	args: string[],
) => Promise<{ success: boolean; data?: unknown; error?: string }>;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown, limit: number): string {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

function https(value: unknown): string {
	const url = text(value, 500);
	return url.startsWith("https://") && !/\s/.test(url) ? url : "";
}

/** One project's result, typed and bounded (from the runner or the file). */
export function linkedResult(raw: unknown): DeployLinkedRollback {
	const r = record(raw);
	const plan = record(r.plan);
	const runId = text(r.run_id ?? r.runId, 20);
	return {
		projectId: text(r.projectId, 100),
		name: text(r.name, 100),
		status: STATUSES.includes(r.status as DeployLinkedStatus) ? (r.status as DeployLinkedStatus) : "error",
		runId: RUN_ID.test(runId) ? runId : "",
		targetUrl: https(plan.target_url ?? r.targetUrl),
		migrations: (Array.isArray(r.migrations) ? r.migrations : [])
			.slice(0, MAX_MIGRATIONS)
			.map((m) => text(m, 300)),
	};
}

export function linkedRollbacksPath(projectPath: string, runId: string): string {
	return path.join(projectPath, ".workpilot", "deploy_watches", `${runId}.linked.json`);
}

/** What the rollback of `runId` took back with it; undefined when nothing was linked. */
export function readLinkedRollbacks(projectPath: string, runId: string): DeployLinkedRollback[] | undefined {
	if (!RUN_ID.test(runId)) return undefined;
	const raw = readJsonFile(linkedRollbacksPath(projectPath, runId), MAX_FILE_BYTES);
	if (!Array.isArray(raw)) return undefined;
	return raw.slice(0, MAX_LINKS).map(linkedResult);
}

function writeLinkedRollbacks(projectPath: string, runId: string, results: DeployLinkedRollback[]): void {
	const file = linkedRollbacksPath(projectPath, runId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(results, null, 2), "utf-8");
	fs.renameSync(temp, file);
}

export interface LinkedRollbackRequest {
	/** The project whose run rolled back. */
	readonly root: Project;
	readonly runId: string;
	/** When the root's last good run was created: where the others go back to. */
	readonly since: string;
	/** Project ids, nearest first (`rollbackOrder`). */
	readonly order: readonly string[];
	readonly findProject: (id: string) => Project | undefined;
	readonly run: LinkedRunner;
}

/**
 * Rolls each linked project back, one after the other, and records what
 * became of them next to the root's watch. Nothing is done without a valid
 * run id and moment. Never throws.
 */
export async function rollBackLinked(request: LinkedRollbackRequest): Promise<DeployLinkedRollback[]> {
	const { root, runId, order, findProject, run } = request;
	const since = isoTime(request.since);
	if (!RUN_ID.test(runId) || !since || order.length === 0) return [];
	const results: DeployLinkedRollback[] = [];
	for (const id of order.slice(0, MAX_LINKS)) {
		const project = findProject(id);
		if (!project || path.resolve(project.path) === path.resolve(root.path)) {
			results.push({ ...linkedResult({ status: "missing" }), projectId: id });
			continue;
		}
		let answer: Awaited<ReturnType<LinkedRunner>>;
		try {
			answer = await run(project, [
				"--action",
				"rollback-linked",
				"--project",
				project.path,
				"--since",
				since,
				"--cause",
				root.name.slice(0, 100),
			]);
		} catch {
			answer = { success: false };
		}
		const result = linkedResult(answer.success ? answer.data : { status: "error" });
		results.push({ ...result, projectId: id, name: project.name.slice(0, 100) });
	}
	try {
		writeLinkedRollbacks(root.path, runId, results);
	} catch {
		// The rollbacks ran; only their record on the page is lost.
	}
	return results;
}
