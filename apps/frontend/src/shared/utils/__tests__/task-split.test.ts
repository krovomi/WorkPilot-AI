import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import type { Task } from "../../types";
import { taskMachine } from "../../state-machines/task-machine";
import {
	autoSplitEnv,
	canStartOnSibling,
	splitChildCount,
	splitPartOf,
	wholeInRange,
} from "../task-split";

function part(id: string, index: number, extra: Partial<Task> = {}): Task {
	return {
		id,
		specId: id,
		status: "queue",
		metadata: {
			splitGroup: { parent: "012-oauth", title: "OAuth", index, total: 3, name: "API" },
		},
		...extra,
	} as Task;
}

describe("autoSplitEnv", () => {
	it("sends nothing for a project on the defaults", () => {
		expect(autoSplitEnv(undefined)).toEqual({});
		expect(autoSplitEnv({})).toEqual({});
	});

	it("sends the switch only when it is off, and only valid ceilings", () => {
		expect(autoSplitEnv({ enabled: false })).toEqual({ WORKPILOT_AUTO_SPLIT: "0" });
		expect(autoSplitEnv({ enabled: true, maxLines: 600, maxFiles: 40 })).toEqual({
			WORKPILOT_SPLIT_MAX_LINES: "600",
			WORKPILOT_SPLIT_MAX_FILES: "40",
		});
		expect(autoSplitEnv({ maxLines: 3, maxFiles: 1.5 })).toEqual({});
	});
});

describe("wholeInRange", () => {
	it("reads typed text and refuses what the backend would ignore", () => {
		expect(wholeInRange("250", [50, 20_000])).toBe(250);
		expect(wholeInRange(" ", [50, 20_000])).toBeUndefined();
		expect(wholeInRange("12.5", [50, 20_000])).toBeUndefined();
		expect(wholeInRange(10, [50, 20_000])).toBeUndefined();
	});
});

describe("split parts", () => {
	it("reads a part and the task that was split", () => {
		expect(splitPartOf(part("012-oauth-part2", 2))).toMatchObject({ index: 2, total: 3 });
		expect(splitPartOf({ metadata: {} } as Task)).toBeNull();
		const parent = { metadata: { splitGroup: { children: ["a", "b"] } } } as Task;
		expect(splitChildCount(parent)).toBe(2);
		expect(splitPartOf(parent)).toBeNull();
	});

	it("lets a part start on a sibling once that one passed QA or opened its PR", () => {
		const second = part("012-oauth-part2", 2);
		const reviewed = part("012-oauth-part1", 1, {
			status: "human_review",
			reviewReason: "completed",
		});
		expect(canStartOnSibling(second, reviewed)).toBe(true);
		expect(canStartOnSibling(second, { ...reviewed, status: "pr_created" })).toBe(true);
		expect(canStartOnSibling(second, { ...reviewed, reviewReason: "errors" })).toBe(false);
		expect(canStartOnSibling(second, { ...reviewed, status: "in_progress" })).toBe(false);
	});

	it("never across two splits, nor for a server card", () => {
		const second = part("012-oauth-part2", 2);
		const other = {
			...part("020-x-part1", 1, { status: "human_review", reviewReason: "completed" }),
			metadata: { splitGroup: { parent: "020-x", index: 1, total: 2 } },
		} as Task;
		expect(canStartOnSibling(second, other)).toBe(false);
		const server = part("server:p1:012-oauth-part2", 2);
		const serverBlocker = part("server:p1:012-oauth-part1", 1, {
			status: "human_review",
			reviewReason: "completed",
		});
		expect(canStartOnSibling(server, serverBlocker)).toBe(false);
	});
});

describe("TASK_SPLIT", () => {
	it.each(["backlog", "planning", "coding"])("settles a task in %s as done", (state) => {
		const actor = createActor(taskMachine, {
			snapshot: taskMachine.resolveState({ value: state, context: {} }),
		});
		actor.start();
		actor.send({ type: "TASK_SPLIT", total: 3 });
		expect(actor.getSnapshot().value).toBe("done");
		actor.stop();
	});
});
