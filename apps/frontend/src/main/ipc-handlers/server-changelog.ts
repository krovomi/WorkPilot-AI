/**
 * The changelog of a server project (server mode).
 *
 * A local project's changelog is built here, from its folder: its done tasks,
 * its git history, a model call. A server project has no folder on this
 * computer, only the mirror of its board, and no git history at all: its
 * changelog is built on the server, as a job on the clone, and saved there as
 * the project's shared report, which every member reads
 * (`apps/backend/shared_features/changelog.py`, `analyses.py`, kind
 * `changelog`). The view's handlers keep their channels and call this module
 * for a server project; every request names the project by its id, never a
 * path, and the cards by their ids on the board.
 *
 * The done cards are the server board's, read fresh into the mirror; the
 * branches, tags and commits are the clone's. Nothing of the project goes to
 * a model on this computer: a version is suggested from the commits' types.
 */

import type {
	BranchDiffOptions,
	ChangelogGenerationProgress,
	ChangelogGenerationRequest,
	ChangelogGenerationResult,
	ChangelogTask,
	ExistingChangelog,
	GitBranchInfo,
	GitCommit,
	GitHistoryOptions,
	GitTagInfo,
	IPCResult,
	Project,
	Task,
	TaskSpecContent,
} from "../../shared/types";
import { getSpecsDir } from "../../shared/constants";
import { changelogService } from "../changelog-service";
import { projectStore } from "../project-store";
import { getRemoteTasks, parseServerTaskId, serverTaskId } from "../remote-board";
import { authedFetch } from "../server-connection";
import {
	AnalysisStopped,
	runServerAnalysis,
	serverAnalysisReport,
} from "./server-analyses";

/** What the view is told while a changelog is built, and when it ends. */
export interface ChangelogEvents {
	progress(projectId: string, progress: ChangelogGenerationProgress): void;
	complete(projectId: string, result: ChangelogGenerationResult): void;
	error(projectId: string, error: string): void;
}

interface Sources {
	branches: GitBranchInfo[];
	tags: GitTagInfo[];
	currentBranch: string;
	defaultBranch: string;
	existing: ExistingChangelog;
}

const MAX_REFS = 500;
const MAX_COMMITS = 1000;
const MAX_TEXT = 1_000;
const STAGES = new Set<ChangelogGenerationProgress["stage"]>([
	"loading_specs",
	"loading_commits",
	"generating",
	"formatting",
	"complete",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, limit = MAX_TEXT): string {
	return typeof value === "string" ? value.slice(0, limit) : "";
}

function failure<T>(error: string): IPCResult<T> {
	return { success: false, error };
}

function query(project: Project, params: Record<string, string | undefined> = {}) {
	const search = new URLSearchParams({ project_id: project.id });
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") search.set(key, value);
	}
	return search.toString();
}

/** The server's answer, checked again: the view draws only what it should. */
export function parseSources(raw: unknown): Sources | null {
	if (!isRecord(raw)) return null;
	const branches = (Array.isArray(raw.branches) ? raw.branches : [])
		.filter(isRecord)
		.slice(0, MAX_REFS)
		.map((b) => ({
			name: text(b.name, 200),
			isRemote: b.isRemote === true,
			isCurrent: b.isCurrent === true,
		}))
		.filter((b) => b.name);
	const tags = (Array.isArray(raw.tags) ? raw.tags : [])
		.filter(isRecord)
		.slice(0, MAX_REFS)
		.map((t) => ({
			name: text(t.name, 200),
			date: text(t.date, 40) || undefined,
			commit: text(t.commit, 64) || undefined,
		}))
		.filter((t) => t.name);
	const found = isRecord(raw.existing) ? raw.existing : {};
	const existing: ExistingChangelog =
		found.exists === true
			? {
					exists: true,
					content: text(found.content, 200_000),
					lastVersion: text(found.lastVersion, 40) || undefined,
				}
			: { exists: false };
	return {
		branches,
		tags,
		currentBranch: text(raw.currentBranch, 200),
		defaultBranch: text(raw.defaultBranch, 200) || "main",
		existing,
	};
}

/** The clone's branches, tags and `CHANGELOG.md`, as the view reads them. */
export async function serverChangelogSources(
	project: Project,
): Promise<IPCResult<Sources>> {
	const result = await authedFetch<unknown>(
		`/api/features/changelog/sources?${query(project)}`,
		"GET",
	);
	if (!result.ok) return failure(result.error);
	const sources = parseSources(result.data);
	return sources ? { success: true, data: sources } : failure("Unexpected answer from the server");
}

export function parseCommits(raw: unknown): GitCommit[] {
	const list = isRecord(raw) && Array.isArray(raw.commits) ? raw.commits : [];
	return list
		.filter(isRecord)
		.slice(0, MAX_COMMITS)
		.map((c) => ({
			hash: text(c.hash, 64),
			fullHash: text(c.fullHash, 64),
			subject: text(c.subject),
			author: text(c.author, 200),
			authorEmail: text(c.authorEmail, 200),
			date: text(c.date, 40),
		}))
		.filter((c) => c.hash);
}

/** The clone's commits a changelog of this range would be built from. */
export async function serverChangelogCommits(
	project: Project,
	options: GitHistoryOptions | BranchDiffOptions,
	mode: "git-history" | "branch-diff",
): Promise<IPCResult<GitCommit[]>> {
	if (!isRecord(options)) return failure("Invalid range");
	const params: Record<string, string | undefined> =
		mode === "branch-diff"
			? {
					mode,
					base_branch: text(options.baseBranch, 200),
					compare_branch: text(options.compareBranch, 200),
				}
			: {
					mode: "git-history",
					type: text(options.type, 40),
					count: typeof options.count === "number" ? String(options.count) : undefined,
					since_date: text(options.sinceDate, 40),
					from_tag: text(options.fromTag, 200),
					to_tag: text(options.toTag, 200),
					include_merge_commits: options.includeMergeCommits === true ? "true" : undefined,
				};
	const result = await authedFetch<unknown>(
		`/api/features/changelog/commits?${query(project, params)}`,
		"GET",
	);
	if (!result.ok) return failure(result.error);
	return { success: true, data: parseCommits(result.data) };
}

/** The server board's cards, fresh from the server, with the ids the view knows. */
async function boardTasks(project: Project): Promise<Task[]> {
	const fresh = await getRemoteTasks(project);
	if (fresh.success && fresh.data) return fresh.data;
	return projectStore
		.getMirrorTasks(project)
		.map((task) => ({ ...task, id: serverTaskId(project.id, task.specId) }));
}

/** The done cards of the server board, read from its mirror. */
export async function serverChangelogDoneTasks(
	project: Project,
): Promise<IPCResult<ChangelogTask[]>> {
	const tasks = await boardTasks(project);
	return {
		success: true,
		data: changelogService.getCompletedTasks(
			project.path,
			tasks,
			getSpecsDir(project.autoBuildPath),
		),
	};
}

/** The specs of the chosen cards, from the mirror of the board. */
export async function serverChangelogSpecs(
	project: Project,
	taskIds: unknown,
): Promise<IPCResult<TaskSpecContent[]>> {
	const ids = Array.isArray(taskIds)
		? taskIds.filter((id): id is string => parseServerTaskId(id)?.projectId === project.id)
		: [];
	const tasks = projectStore
		.getMirrorTasks(project)
		.map((task) => ({ ...task, id: serverTaskId(project.id, task.specId) }));
	const specs = await changelogService.loadTaskSpecs(
		project.path,
		ids,
		tasks,
		getSpecsDir(project.autoBuildPath),
	);
	return { success: true, data: specs };
}

/** The request as the server's closed model reads it; null if it names nothing. */
export function toServerOptions(
	project: Project,
	request: ChangelogGenerationRequest,
): Record<string, unknown> {
	const cards = (request.taskIds ?? [])
		.map((id) => parseServerTaskId(id))
		.filter((card) => card?.projectId === project.id)
		.map((card) => card?.cardId as string);
	const history = request.gitHistory;
	const diff = request.branchDiff;
	return {
		source_mode: request.sourceMode,
		task_ids: request.sourceMode === "tasks" ? [...new Set(cards)] : [],
		git_history:
			request.sourceMode === "git-history" && history
				? {
						type: history.type,
						count: history.count ?? 25,
						since_date: history.sinceDate || null,
						from_tag: history.fromTag || null,
						to_tag: history.toTag || null,
						include_merge_commits: history.includeMergeCommits === true,
					}
				: null,
		branch_diff:
			request.sourceMode === "branch-diff" && diff
				? { base_branch: diff.baseBranch, compare_branch: diff.compareBranch }
				: null,
		version: request.version || "1.0.0",
		date: request.date,
		format: request.format,
		audience: request.audience,
		emoji_level: request.emojiLevel ?? "none",
		custom_instructions: request.customInstructions ?? "",
	};
}

/**
 * Build a server project's changelog on the server, telling the view its
 * progress, then the changelog saved for every member, or why it failed.
 */
export async function generateServerChangelog(
	project: Project,
	request: ChangelogGenerationRequest,
	events: ChangelogEvents,
): Promise<void> {
	const onEvent = (payload: unknown) => {
		if (!isRecord(payload) || !STAGES.has(payload.stage as never)) return;
		events.progress(project.id, {
			stage: payload.stage as ChangelogGenerationProgress["stage"],
			progress: typeof payload.progress === "number" ? payload.progress : 0,
			message: text(payload.message, 200),
		});
	};
	try {
		const report = await runServerAnalysis(
			project,
			"changelog",
			toServerOptions(project, request),
			onEvent,
		);
		const saved = isRecord(report) ? report : {};
		const changelog = text(saved.changelog, 1_000_000);
		if (!changelog) throw new Error("The changelog was not saved on the server");
		events.complete(project.id, {
			success: true,
			changelog,
			version: text(saved.version, 40) || request.version,
			tasksIncluded: typeof saved.itemsIncluded === "number" ? saved.itemsIncluded : 0,
		});
	} catch (error) {
		// Stopped by a new build of the same changelog: that one answers.
		if (error instanceof AnalysisStopped) return;
		events.error(project.id, error instanceof Error ? error.message : String(error));
	}
}

/** Keep a member's correction of the shared changelog on the server. */
export async function saveServerChangelog(
	project: Project,
	content: unknown,
): Promise<IPCResult<{ filePath: string; bytesWritten: number }>> {
	if (typeof content !== "string" || !content.trim()) {
		return failure("No changelog to save");
	}
	const result = await authedFetch<unknown>(
		`/api/features/changelog/report?${query(project)}`,
		"PUT",
		{ changelog: content },
	);
	if (!result.ok) return failure(result.error);
	return {
		success: true,
		// Saved as the project's shared changelog, not as a file of this computer.
		data: { filePath: "", bytesWritten: Buffer.byteLength(content, "utf-8") },
	};
}

/** The last changelog a member built for a server project; null if none. */
export async function sharedServerChangelog(project: Project) {
	return serverAnalysisReport(project, "changelog");
}

/**
 * The next version from the commits' conventional types, with no model: a
 * breaking change bumps the major, a feature the minor, anything else the
 * patch. The reason is the view's (`breaking`, `feature`, `patch`).
 */
export function suggestVersionFromCommitTypes(
	commits: unknown,
	currentVersion: string | undefined,
): { version: string; reason: string } {
	const parts = (currentVersion ?? "").split(".").map(Number);
	if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
		return { version: "1.0.0", reason: "initial" };
	}
	const subjects = (Array.isArray(commits) ? commits : [])
		.filter(isRecord)
		.map((c) => text(c.subject));
	const [major, minor, patch] = parts;
	if (subjects.some((s) => /^\w+(\([^)]*\))?!:/.test(s) || /BREAKING[ -]CHANGE/.test(s))) {
		return { version: `${major + 1}.0.0`, reason: "breaking" };
	}
	if (subjects.some((s) => /^feat(ure)?(\([^)]*\))?:/i.test(s))) {
		return { version: `${major}.${minor + 1}.0`, reason: "feature" };
	}
	return { version: `${major}.${minor}.${patch + 1}`, reason: "patch" };
}
