/**
 * Review comments anchored on a line (`docs/architecture/review-comments.md`).
 *
 * The renderer sends a task id, a relative path, a side, a line and a text.
 * Everything else is decided here: the path must stay inside the task's
 * worktree, the line must exist, the excerpt and the commit are read from
 * git, never taken from the renderer (rule S6). The file is written in every
 * copy of the spec directory; reading takes the union, newest change winning,
 * because the backend marks comments `addressed` in its own copy.
 *
 * Only the person resolves a comment: there is no channel for the agent.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type { ReviewComment } from "../../../shared/types/review-comments";
import {
	MAX_COMMENTS,
	REVIEW_COMMENTS_FILE,
	checkCommentInput,
	excerptAround,
	locateComment,
	parseCommentCopies,
	safeRelativePath,
	serializeComments,
} from "../../../shared/utils/review-comments";
import { getToolPath } from "../../cli-tool-manager";
import { findServerCard } from "../../server-board-actions";
import { findTaskWorktree } from "../../worktree-paths";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

const TASK_ID_MAX = 300;
type Result = IPCResult<ReviewComment[]>;

interface Place {
	worktree: string;
	dirs: string[];
}

function refused(error: string): Result {
	return { success: false, error };
}

function place(taskId: unknown): Place | string {
	if (typeof taskId !== "string" || !taskId || taskId.length > TASK_ID_MAX) return "task_not_found";
	// A server card's worktree is on the server: its review keeps the free text.
	if (findServerCard(taskId)) return "local_only";
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return "task_not_found";
	const worktree = findTaskWorktree(project.path, task.specId);
	if (!worktree) return "no_worktree";
	const dirs = allSpecDirs(getSpecPaths(task, project));
	if (dirs.length === 0) return "no_spec";
	return { worktree, dirs };
}

function read(file: string): string {
	try {
		return readFileSync(file, "utf-8");
	} catch {
		return ""; // no comment yet in this copy
	}
}

function load(dirs: string[]): ReviewComment[] {
	return parseCommentCopies(dirs.map((d) => read(path.join(d, REVIEW_COMMENTS_FILE))));
}

function save(dirs: string[], comments: ReviewComment[]): boolean {
	const payload = serializeComments(comments);
	let written = 0;
	for (const dir of dirs) {
		const file = path.join(dir, REVIEW_COMMENTS_FILE);
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
			renameSync(tmp, file);
			written++;
		} catch (error) {
			console.error("[REVIEW_COMMENTS] could not write", file, error);
		}
	}
	return written > 0;
}

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync(getToolPath("git"), args, {
			cwd,
			encoding: "utf-8",
			maxBuffer: 32 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
}

/** The file inside the worktree, or null when the path (or a link on it) leaves it. */
function insideWorktree(worktree: string, relative: string): string | null {
	const root = path.resolve(worktree);
	const absolute = path.resolve(root, relative);
	if (!absolute.startsWith(root + path.sep)) return null;
	try {
		const real = realpathSync(absolute);
		return real.startsWith(realpathSync(root) + path.sep) ? absolute : null;
	} catch {
		return absolute; // not on disk (a removed line): only git reads it
	}
}

function lines(text: string): string[] {
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** The lines of the commented version of the file: the worktree's, or a commit's. */
function fileLines(where: Place, relative: string, commit?: string): string[] | null {
	if (commit) {
		const shown = git(where.worktree, ["show", `${commit}:${relative}`]);
		return shown === null ? null : lines(shown);
	}
	const absolute = insideWorktree(where.worktree, relative);
	if (!absolute) return null;
	try {
		return lines(readFileSync(absolute, "utf-8"));
	} catch {
		return null;
	}
}

/** Open comments whose lines are gone from the worktree become stale. */
function refreshStale(where: Place, comments: ReviewComment[]): boolean {
	let changed = false;
	const now = new Date().toISOString();
	for (const c of comments) {
		if (c.status !== "open" || c.side !== "new") continue;
		const current = fileLines(where, c.path);
		if (current && locateComment(current, c) === null) {
			c.status = "stale";
			c.updatedAt = now;
			changed = true;
		}
	}
	return changed;
}

export async function listReviewComments(taskId: unknown): Promise<Result> {
	const where = place(taskId);
	if (typeof where === "string") return refused(where);
	const comments = load(where.dirs);
	if (refreshStale(where, comments)) save(where.dirs, comments);
	return { success: true, data: comments };
}

export async function addReviewComment(taskId: unknown, raw: unknown): Promise<Result> {
	const where = place(taskId);
	if (typeof where === "string") return refused(where);
	const checked = checkCommentInput(raw);
	if (!checked.ok) return refused(checked.error);
	const { input } = checked;
	if (!insideWorktree(where.worktree, input.path)) return refused("invalid_path");
	if (input.commit && git(where.worktree, ["cat-file", "-e", `${input.commit}^{commit}`]) === null) {
		return refused("invalid_commit");
	}
	const head = git(where.worktree, ["rev-parse", "HEAD"])?.trim() ?? "";
	const version = input.commit ?? (input.side === "old" ? head : undefined);
	if (input.side === "old" && !version) return refused("invalid_commit");
	const content = fileLines(where, input.path, version);
	if (!content) return refused("invalid_path");
	const anchor = excerptAround(content, input.line);
	if (!anchor) return refused("invalid_line");

	const comments = load(where.dirs);
	if (comments.length >= MAX_COMMENTS) return refused("too_many_comments");
	const now = new Date().toISOString();
	comments.push({
		id: randomUUID(),
		path: input.path,
		side: input.side,
		line: input.line,
		commit: version ?? head,
		excerpt: anchor.excerpt,
		excerptOffset: anchor.offset,
		text: input.text,
		status: "open",
		createdAt: now,
		updatedAt: now,
		addressedSession: null,
	});
	return save(where.dirs, comments) ? { success: true, data: comments } : refused("not_writable");
}

/** The person reopens or resolves a comment, or deletes it. */
export async function updateReviewComment(taskId: unknown, id: unknown, action: unknown): Promise<Result> {
	const where = place(taskId);
	if (typeof where === "string") return refused(where);
	if (typeof id !== "string" || !["resolve", "reopen", "delete"].includes(String(action))) {
		return refused("invalid_action");
	}
	const comments = load(where.dirs);
	const index = comments.findIndex((c) => c.id === id);
	if (index < 0) return refused("comment_not_found");
	if (action === "delete") {
		comments.splice(index, 1);
	} else {
		comments[index].status = action === "resolve" ? "resolved" : "open";
		comments[index].updatedAt = new Date().toISOString();
	}
	return save(where.dirs, comments) ? { success: true, data: comments } : refused("not_writable");
}

/**
 * The open comments among `ids`, read from the files, for `QA_FIX_REQUEST.md`.
 * An id the renderer made up, or a path outside the worktree, is dropped.
 */
export function openCommentsFor(taskId: string, ids: unknown): ReviewComment[] {
	if (!Array.isArray(ids) || ids.length === 0) return [];
	const where = place(taskId);
	if (typeof where === "string") return [];
	const wanted = new Set(ids.filter((i): i is string => typeof i === "string"));
	return load(where.dirs)
		.filter(
			(c) =>
				wanted.has(c.id) &&
				c.status === "open" &&
				safeRelativePath(c.path) !== null &&
				insideWorktree(where.worktree, c.path) !== null,
		)
		.map((c) => {
			// The fixer reads the worktree: give it the line where the excerpt is now.
			if (c.side !== "new") return c;
			const current = fileLines(where, c.path);
			const line = current ? locateComment(current, c) : null;
			return line ? { ...c, line } : c;
		});
}

export function registerReviewCommentsHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TASK_REVIEW_COMMENTS_LIST, (_, taskId: unknown) => listReviewComments(taskId));
	ipcMain.handle(IPC_CHANNELS.TASK_REVIEW_COMMENT_ADD, (_, taskId: unknown, input: unknown) =>
		addReviewComment(taskId, input),
	);
	ipcMain.handle(
		IPC_CHANNELS.TASK_REVIEW_COMMENT_UPDATE,
		(_, taskId: unknown, id: unknown, action: unknown) => updateReviewComment(taskId, id, action),
	);
}
