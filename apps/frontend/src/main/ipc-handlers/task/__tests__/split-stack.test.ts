/**
 * @vitest-environment node
 *
 * A part of a split task starts on the part it builds on: stacked on it when
 * that part is not merged yet, from the trunk once it is, never twice, and
 * never for a server card. A refused stack refuses the start.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	tasks: [] as Task[],
	worktrees: {} as Record<string, string>,
	stackResult: { success: true, data: {} } as {
		success: boolean;
		data?: Record<string, unknown>;
		error?: string;
	},
	stackCalls: [] as Array<[unknown, unknown]>,
}));

vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../project-store", () => ({ projectStore: { getTasks: () => state.tasks } }));
vi.mock("../../../worktree-paths", () => ({
	findTaskWorktree: (_root: string, specId: string) => state.worktrees[specId] ?? null,
}));
vi.mock("../stack-handlers", () => ({
	stackOn: vi.fn(async (child: unknown, parent: unknown) => {
		state.stackCalls.push([child, parent]);
		return state.stackResult;
	}),
}));

import {
	splitStackError,
	stackSplitPartBeforeStart,
	unmergedSiblingBlocker,
} from "../split-stack";

const project = { id: "p", path: "/repo" } as Project;

function part(id: string, index: number, extra: Partial<Task> = {}): Task {
	return {
		id,
		specId: id,
		status: "queue",
		subtasks: [],
		metadata: {
			splitGroup: { parent: "012-oauth", title: "OAuth", index, total: 2 },
			...(index > 1 ? { blockedBy: ["012-oauth-part1"] } : {}),
		},
		...extra,
	} as Task;
}

beforeEach(() => {
	state.tasks = [];
	state.worktrees = {};
	state.stackCalls = [];
	state.stackResult = {
		success: true,
		data: { baseBranch: "workpilot/012-oauth-part1", stackParent: "012-oauth-part1" },
	};
});

describe("stackSplitPartBeforeStart", () => {
	it("stacks a part on its unmerged sibling and updates its metadata in place", async () => {
		const first = part("012-oauth-part1", 1, { status: "human_review" });
		const second = part("012-oauth-part2", 2);
		state.tasks = [first, second];
		const result = await stackSplitPartBeforeStart(second, project);
		expect(result).toEqual({ ok: true, stackedOn: "012-oauth-part1" });
		expect(state.stackCalls).toEqual([["012-oauth-part2", "012-oauth-part1"]]);
		expect(second.metadata?.baseBranch).toBe("workpilot/012-oauth-part1");
	});

	it("starts from the trunk once the sibling is merged", async () => {
		const second = part("012-oauth-part2", 2);
		state.tasks = [part("012-oauth-part1", 1, { status: "done" }), second];
		expect(await stackSplitPartBeforeStart(second, project)).toEqual({ ok: true });
		expect(state.stackCalls).toEqual([]);
	});

	it("does nothing for a first part, an ordinary task, a started or stacked part", async () => {
		const first = part("012-oauth-part1", 1);
		const plain = { id: "x", specId: "x", status: "queue", metadata: {} } as Task;
		const started = part("012-oauth-part2", 2);
		const stacked = part("012-oauth-part2", 2);
		stacked.metadata = { ...stacked.metadata, stackParent: "012-oauth-part1" };
		state.tasks = [part("012-oauth-part1", 1, { status: "human_review" }), started];
		state.worktrees["012-oauth-part2"] = "/repo/.workpilot/worktrees/tasks/012-oauth-part2";
		for (const task of [first, plain, started, stacked]) {
			expect(await stackSplitPartBeforeStart(task, project)).toEqual({ ok: true });
		}
		expect(state.stackCalls).toEqual([]);
	});

	it("leaves a server card alone: stacking runs git on this computer", async () => {
		const second = part("server:p1:012-oauth-part2", 2);
		state.tasks = [part("012-oauth-part1", 1, { status: "human_review" }), second];
		expect(await stackSplitPartBeforeStart(second, project)).toEqual({ ok: true });
		expect(state.stackCalls).toEqual([]);
	});

	it("refuses the start when the stack is refused", async () => {
		state.stackResult = { success: false, error: "parent_no_commits" };
		const second = part("012-oauth-part2", 2);
		state.tasks = [part("012-oauth-part1", 1, { status: "human_review" }), second];
		expect(await stackSplitPartBeforeStart(second, project)).toEqual({
			ok: false,
			error: "parent_no_commits",
		});
		expect(splitStackError(second, "parent_no_commits")).toContain("part 2/2");
	});
});

describe("unmergedSiblingBlocker", () => {
	it("ignores a blocker from another split", () => {
		const second = part("012-oauth-part2", 2);
		const stranger = {
			id: "012-oauth-part1",
			specId: "012-oauth-part1",
			status: "human_review",
			metadata: { splitGroup: { parent: "999-other", index: 1, total: 2 } },
		} as Task;
		expect(unmergedSiblingBlocker(second, [stranger, second])).toBeUndefined();
	});
});
