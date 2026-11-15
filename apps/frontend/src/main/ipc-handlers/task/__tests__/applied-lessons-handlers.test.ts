/**
 * Applied lessons (#345): every copy of the spec directory is read and merged
 * by lesson; turning one off writes `disabled` in every copy and keeps the
 * backend's `lessons` as they were. The renderer can only name a lesson the
 * task actually carried.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	dirs: { main: "", worktree: "" as string | null },
	found: true,
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../shared", () => ({
	findTaskAndProject: () =>
		state.found ? { task: { id: "t1", specId: "001-x" }, project: { path: "/p" } } : {},
}));
vi.mock("../resume-task", () => ({
	getSpecPaths: () => ({
		specDir: state.dirs.main,
		mainSpecDir: state.dirs.main,
		worktreeSpecDir: state.dirs.worktree,
	}),
	allSpecDirs: (p: { specDir: string; worktreeSpecDir: string | null }) =>
		[p.specDir, p.worktreeSpecDir].filter((d): d is string => !!d && existsSync(d)),
}));
vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../server-board-actions", () => ({
	findServerCard: (id: unknown) => (id === "server:p-1:001-a" ? { cardId: "001-a" } : null),
}));

import {
	APPLIED_FILE,
	mergeApplied,
	registerAppliedLessonsHandlers,
} from "../applied-lessons-handlers";

registerAppliedLessonsHandlers();

type State = { lessons: { id: string; agents: string[]; text: string; kind: string }[]; disabled: string[] };
const call = (channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args) as Promise<{ success: boolean; error?: string; data?: State }>;

const RULE = { id: "a1b2c3d4e5f60718", kind: "rule", text: "Keep EF out of Domain.", agent: "spec_writer", at: "2026-11-14T10:00:00Z" };
const PATTERN = {
	id: "lp-0123456789ab",
	kind: "pattern",
	text: "Run the migrations first.",
	agent: "coder",
	pattern_type: "failure",
	confidence: 0.8,
	at: "2026-11-14T11:00:00Z",
};

let root = "";
const file = (dir: string) => path.join(dir, APPLIED_FILE);
const write = (dir: string, data: unknown) => writeFileSync(file(dir), JSON.stringify(data));
const read = (dir: string) => JSON.parse(readFileSync(file(dir), "utf-8"));

describe("applied lessons handlers", () => {
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "lessons-"));
		state.dirs.main = path.join(root, "main");
		state.dirs.worktree = path.join(root, "wt");
		mkdirSync(state.dirs.main);
		mkdirSync(state.dirs.worktree);
		state.found = true;
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("merges every copy, one entry per lesson with all its agents", async () => {
		write(state.dirs.main, { lessons: [RULE], disabled: [] });
		write(state.dirs.worktree as string, {
			lessons: [{ ...RULE, agent: "coder", at: "2026-11-14T12:00:00Z" }, PATTERN],
			disabled: [],
		});
		const result = await call(IPC_CHANNELS.TASK_LESSONS_GET, "t1");
		expect(result.success).toBe(true);
		expect(result.data?.lessons.map((l) => [l.id, l.agents])).toEqual([
			[RULE.id, ["spec_writer", "coder"]],
			[PATTERN.id, ["coder"]],
		]);
		expect(result.data?.lessons[1]).toMatchObject({ patternType: "failure", confidence: 0.8 });
	});

	it("turns a lesson off in every copy and keeps the backend's lessons", async () => {
		write(state.dirs.main, { lessons: [RULE], disabled: [] });
		const result = await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "t1", RULE.id, true);
		expect(result.success).toBe(true);
		expect(result.data?.disabled).toEqual([RULE.id]);
		expect(read(state.dirs.main)).toEqual({ lessons: [RULE], disabled: [RULE.id] });
		// The worktree copy had no file yet: its next prompt must still leave the lesson out.
		expect(read(state.dirs.worktree as string)).toEqual({ lessons: [], disabled: [RULE.id] });

		const back = await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "t1", RULE.id, false);
		expect(back.data?.disabled).toEqual([]);
		expect(read(state.dirs.main).disabled).toEqual([]);
	});

	it("refuses a lesson the task never carried, and writes nothing", async () => {
		write(state.dirs.main, { lessons: [RULE], disabled: [] });
		const result = await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "t1", "lp-made-up", true);
		expect(result.success).toBe(false);
		expect(read(state.dirs.main).disabled).toEqual([]);
		expect(existsSync(file(state.dirs.worktree as string))).toBe(false);
	});

	it.each([
		["t1", "../../etc", true],
		["t1", "a".repeat(81), true],
		["t1", RULE.id, "yes"],
		[{ id: "t1" }, RULE.id, true],
	])("refuses hostile arguments (%j, %j, %j)", async (taskId, lessonId, disabled) => {
		write(state.dirs.main, { lessons: [RULE], disabled: [] });
		const result = await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, taskId, lessonId, disabled);
		expect(result.success).toBe(false);
		expect(read(state.dirs.main).disabled).toEqual([]);
	});

	it("never reads through a planted link, and replaces it on write", async () => {
		const outside = path.join(root, "outside.json");
		writeFileSync(outside, JSON.stringify({ lessons: [RULE], disabled: [] }));
		symlinkSync(outside, file(state.dirs.main));
		expect((await call(IPC_CHANNELS.TASK_LESSONS_GET, "t1")).data?.lessons).toEqual([]);

		write(state.dirs.worktree as string, { lessons: [RULE], disabled: [] });
		await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "t1", RULE.id, true);
		expect(JSON.parse(readFileSync(outside, "utf-8")).disabled).toEqual([]);
		expect(lstatSync(file(state.dirs.main)).isSymbolicLink()).toBe(false);
	});

	it("shows nothing for a server card and refuses to change it", async () => {
		expect((await call(IPC_CHANNELS.TASK_LESSONS_GET, "server:p-1:001-a")).data).toEqual({
			lessons: [],
			disabled: [],
		});
		const set = await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "server:p-1:001-a", RULE.id, true);
		expect(set.success).toBe(false);
	});

	it("says when the task is unknown", async () => {
		state.found = false;
		expect((await call(IPC_CHANNELS.TASK_LESSONS_GET, "t1")).success).toBe(false);
		expect((await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "t1", RULE.id, true)).error).toBe(
			"Task not found",
		);
	});

	it.each([[""], [42], [null]])("refuses a task id that is not one (%j)", async (taskId) => {
		expect(await call(IPC_CHANNELS.TASK_LESSONS_GET, taskId)).toEqual({
			success: false,
			error: "taskId is required",
		});
		expect((await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, taskId, RULE.id, true)).success).toBe(false);
	});

	it.each([[null], [[RULE]], [7]])("reads a file that is not an object (%j) as empty", async (content) => {
		write(state.dirs.main, content);
		expect((await call(IPC_CHANNELS.TASK_LESSONS_GET, "t1")).data).toEqual({ lessons: [], disabled: [] });
	});

	it("refuses to turn off more lessons than a task can hold", async () => {
		const many = Array.from({ length: 200 }, (_, i) => `lp-${i}`);
		write(state.dirs.main, { lessons: [RULE], disabled: many });
		const result = await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "t1", RULE.id, true);
		expect(result).toEqual({ success: false, error: "Too many lessons turned off for one task" });
		expect(read(state.dirs.main).disabled).toHaveLength(200);
	});

	it("says which copy it could not update, since that copy would still hand the lesson out", async () => {
		write(state.dirs.main, { lessons: [RULE], disabled: [] });
		// A directory where the file goes: the rename over it fails.
		const blocked = file(state.dirs.worktree as string);
		mkdirSync(blocked);
		writeFileSync(path.join(blocked, "keep"), "x");
		const result = await call(IPC_CHANNELS.TASK_LESSONS_SET_DISABLED, "t1", RULE.id, true);
		expect(result.success).toBe(false);
		expect(result.error).toContain(state.dirs.worktree as string);
	});
});

describe("mergeApplied", () => {
	it("drops malformed rows and ids, and puts checkpoints first", () => {
		const merged = mergeApplied([
			{
				lessons: [
					PATTERN,
					{ id: "../x", kind: "rule", text: "x", agent: "coder" },
					{ id: "ok-1", kind: "verdict", text: "x", agent: "coder" },
					{ id: "ok-2", kind: "rule", text: "   ", agent: "coder" },
					{ id: "checkpoint-bug_fix-1", kind: "checkpoint", text: "Reproduce it.", agent: "Spec Writer!" },
					"not a row",
				],
				disabled: ["ok-1", 3, "../y"],
			},
			{ lessons: "nope" },
		]);
		expect(merged.lessons.map((l) => [l.id, l.agents])).toEqual([
			["checkpoint-bug_fix-1", []],
			[PATTERN.id, ["coder"]],
		]);
		expect(merged.disabled).toEqual(["ok-1"]);
	});

	it("keeps the newest text of a lesson seen twice, and each agent once", () => {
		const merged = mergeApplied([
			{ lessons: [RULE, { ...RULE, text: "Older.", at: "2026-11-13T00:00:00Z" }] },
			{ lessons: [{ ...RULE, agent: undefined, text: "Newest.", at: "2026-11-15T00:00:00Z" }] },
			{ lessons: [{ ...RULE, at: undefined, text: "Undated." }] },
			{ lessons: [{ ...RULE, id: "r-2", text: 3 }] },
		]);
		expect(merged.lessons).toEqual([
			{ id: RULE.id, kind: "rule", text: "Newest.", agents: ["spec_writer"], at: "2026-11-15T00:00:00Z" },
		]);
	});

	it("keeps a lesson without a date when the first one had none either", () => {
		const undated = { id: "r-3", kind: "rule", text: "First.", agent: "coder" };
		const merged = mergeApplied([{ lessons: [undated, { ...undated, text: "Later.", at: "2026-11-15T00:00:00Z" }] }]);
		expect(merged.lessons[0]).toMatchObject({ text: "Later.", at: "2026-11-15T00:00:00Z" });
	});

	it("holds at most 120 lessons", () => {
		const rows = Array.from({ length: 130 }, (_, i) => ({ id: `r-${i}`, kind: "rule", text: "x", agent: "coder" }));
		expect(mergeApplied([{ lessons: rows }]).lessons).toHaveLength(120);
	});
});
