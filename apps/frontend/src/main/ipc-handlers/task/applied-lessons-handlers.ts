/**
 * The lessons a task's prompts carried, and the ones its person turned off.
 *
 * The backend records what each prompt was given in
 * `<spec>/applied_lessons.json` (`learning_loop/applied.py`), in the copy of
 * the spec directory the prompt ran from: the spec and the plan in the main
 * copy, the coder and the QA in the worktree's. This handler reads every copy
 * and merges them by lesson, so the panel says "N lessons applied to this
 * task" once.
 *
 * Turning a lesson off writes its id to `disabled`, in every copy: whichever
 * copy the next prompt reads, the lesson is left out. Each side keeps the
 * other's field as it found it: the backend never touches `disabled`, this
 * handler never touches `lessons`. Both write to a temporary file and rename
 * it, so neither reads half a file and a symbolic link planted at the name is
 * replaced, not followed (and never read).
 *
 * The renderer names a task, a lesson and a state. The id is checked against
 * the backend's pattern and against the lessons the task actually carried,
 * so the renderer cannot fill the file with ids of its own.
 *
 * A server card's prompts run on the server: nothing is recorded here, and
 * the card shows nothing.
 *
 * Channels:
 *   invoke TASK_LESSONS_GET (taskId)                              → IPCResult<AppliedLessonsState>
 *   invoke TASK_LESSONS_SET_DISABLED (taskId, lessonId, disabled) → IPCResult<AppliedLessonsState>
 */

import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	AppliedLesson,
	AppliedLessonKind,
	AppliedLessonsState,
	IPCResult,
} from "../../../shared/types";
import { appLog } from "../../app-logger";
import { findServerCard } from "../../server-board-actions";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

export const APPLIED_FILE = "applied_lessons.json";
/** The backend's `LESSON_ID`. */
export const LESSON_ID = /^[A-Za-z0-9_-]{1,80}$/;
const KINDS: readonly AppliedLessonKind[] = ["rule", "pattern", "checkpoint"];
const AGENT = /^[a-z0-9_]{1,64}$/;
const MAX_TEXT = 600;
/** The backend keeps 60 rows per copy; a lesson given to several agents is one row each. */
const MAX_LESSONS = 120;
const MAX_DISABLED = 200;

type Raw = Record<string, unknown>;

/** The file of one copy, or `{}` when it is absent, a link, or not an object. */
export function readAppliedFile(dir: string): Raw {
	const file = path.join(dir, APPLIED_FILE);
	try {
		if (!lstatSync(file).isFile()) return {};
		const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
		return data && typeof data === "object" && !Array.isArray(data) ? (data as Raw) : {};
	} catch {
		return {};
	}
}

function disabledOf(data: Raw): string[] {
	const raw = data.disabled;
	if (!Array.isArray(raw)) return [];
	return raw.filter((id): id is string => typeof id === "string" && LESSON_ID.test(id));
}

/** Every copy merged: one entry per lesson, with every agent it went to. */
export function mergeApplied(copies: Raw[]): AppliedLessonsState {
	const byId = new Map<string, AppliedLesson>();
	const disabled = new Set<string>();
	for (const data of copies) {
		for (const id of disabledOf(data)) disabled.add(id);
		const rows = Array.isArray(data.lessons) ? data.lessons : [];
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const r = row as Raw;
			const id = typeof r.id === "string" && LESSON_ID.test(r.id) ? r.id : null;
			const kind = KINDS.find((k) => k === r.kind);
			const text = typeof r.text === "string" ? r.text.trim().slice(0, MAX_TEXT) : "";
			if (!id || !kind || !text) continue;
			const agent = typeof r.agent === "string" && AGENT.test(r.agent) ? r.agent : null;
			const at = typeof r.at === "string" ? r.at : undefined;
			const known = byId.get(id);
			if (known) {
				if (agent && !known.agents.includes(agent)) known.agents.push(agent);
				if (at && (!known.at || at > known.at)) {
					known.at = at;
					known.text = text;
				}
				continue;
			}
			if (byId.size >= MAX_LESSONS) continue;
			const lesson: AppliedLesson = { id, kind, text, agents: agent ? [agent] : [] };
			if (typeof r.pattern_type === "string") lesson.patternType = r.pattern_type.slice(0, 20);
			if (typeof r.confidence === "number" && Number.isFinite(r.confidence)) {
				lesson.confidence = r.confidence;
			}
			if (at) lesson.at = at;
			byId.set(id, lesson);
		}
	}
	const order: Record<AppliedLessonKind, number> = { checkpoint: 0, rule: 1, pattern: 2 };
	const lessons = [...byId.values()].sort((a, b) => order[a.kind] - order[b.kind]);
	return { lessons, disabled: [...disabled] };
}

/** Write `disabled` in every copy, keeping each copy's `lessons`. Returns the copies that failed. */
export function writeDisabled(dirs: string[], disabled: string[]): string[] {
	const failed: string[] = [];
	for (const dir of dirs) {
		const file = path.join(dir, APPLIED_FILE);
		const data = readAppliedFile(dir);
		data.disabled = disabled;
		if (!Array.isArray(data.lessons)) data.lessons = [];
		try {
			const temp = `${file}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(data, null, 2), "utf-8");
			renameSync(temp, file);
		} catch (error) {
			appLog.warn(`[TASK_LESSONS_SET_DISABLED] Could not update ${dir}:`, error);
			failed.push(dir);
		}
	}
	return failed;
}

function lessonDirs(taskId: string): string[] | null {
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return null;
	return allSpecDirs(getSpecPaths(task, project));
}

const EMPTY: AppliedLessonsState = { lessons: [], disabled: [] };

export function registerAppliedLessonsHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.TASK_LESSONS_GET,
		async (_, taskId: unknown): Promise<IPCResult<AppliedLessonsState>> => {
			if (typeof taskId !== "string" || !taskId) {
				return { success: false, error: "taskId is required" };
			}
			if (findServerCard(taskId)) return { success: true, data: EMPTY };
			const dirs = lessonDirs(taskId);
			if (!dirs) return { success: false, error: "Task not found" };
			return { success: true, data: mergeApplied(dirs.map(readAppliedFile)) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_LESSONS_SET_DISABLED,
		async (
			_,
			taskId: unknown,
			lessonId: unknown,
			disabled: unknown,
		): Promise<IPCResult<AppliedLessonsState>> => {
			if (typeof taskId !== "string" || !taskId) {
				return { success: false, error: "taskId is required" };
			}
			if (typeof lessonId !== "string" || !LESSON_ID.test(lessonId)) {
				return { success: false, error: "Invalid lesson id" };
			}
			if (typeof disabled !== "boolean") {
				return { success: false, error: "disabled must be true or false" };
			}
			if (findServerCard(taskId)) {
				return { success: false, error: "A server task's lessons are applied on the server" };
			}
			const dirs = lessonDirs(taskId);
			if (!dirs) return { success: false, error: "Task not found" };
			const current = mergeApplied(dirs.map(readAppliedFile));
			const known =
				current.lessons.some((lesson) => lesson.id === lessonId) ||
				current.disabled.includes(lessonId);
			if (!known) return { success: false, error: "This task did not carry that lesson" };
			const next = current.disabled.filter((id) => id !== lessonId);
			if (disabled) next.push(lessonId);
			if (next.length > MAX_DISABLED) {
				return { success: false, error: "Too many lessons turned off for one task" };
			}
			const failed = writeDisabled(dirs, next);
			if (failed.length > 0) {
				// A copy left as it was would still hand the lesson to its prompts.
				return { success: false, error: `Could not update ${failed.join(", ")}` };
			}
			appLog.info(
				`[TASK_LESSONS_SET_DISABLED] task=${taskId} lesson=${lessonId} disabled=${disabled} dirs=${dirs.length}`,
			);
			return { success: true, data: { ...current, disabled: next } };
		},
	);
}
