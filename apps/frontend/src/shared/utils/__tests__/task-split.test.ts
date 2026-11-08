import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { TASK_KINDS, type Task } from "../../types";
import { taskMachine } from "../../state-machines/task-machine";
import {
	AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND,
	autoSplitCeilingFor,
	autoSplitEnv,
	canStartOnSibling,
	kindFromCategory,
	NEVER_SPLIT_KINDS,
	partsAwaitingMerge,
	partsToMoveOntoBase,
	prUrlOf,
	SPLIT_GROUP_TONES,
	SPLIT_KINDS,
	splitChildCount,
	splitGroupId,
	splitGroupTone,
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
		expect(
			autoSplitEnv({
				enabled: true,
				maxLinesByKind: { bug_fix: 150, feature: 600 },
				maxFiles: 40,
			}),
		).toEqual({
			WORKPILOT_SPLIT_MAX_LINES_BY_KIND: JSON.stringify({
				feature: 600,
				bug_fix: 150,
			}),
			WORKPILOT_SPLIT_MAX_FILES: "40",
		});
		expect(
			autoSplitEnv({ maxLinesByKind: { bug_fix: 3, docs: 1.5 }, maxFiles: 1.5 }),
		).toEqual({});
	});
});

describe("ceilings by kind of task", () => {
	it("keeps the backend's defaults (task_split/policy.py)", () => {
		expect(AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND).toEqual({
			hotfix: 100,
			bug_fix: 200,
			feature: 400,
			refactoring: 300,
			upgrade: 200,
			test: 400,
			docs: 400,
		});
		expect([...SPLIT_KINDS].sort()).toEqual(
			Object.keys(AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND).sort(),
		);
		expect([...SPLIT_KINDS, ...NEVER_SPLIT_KINDS].sort()).toEqual(
			[...TASK_KINDS].sort(),
		);
	});

	it("gives the project's ceiling for the task's kind, else the default", () => {
		const settings = { maxLinesByKind: { bug_fix: 150 } };
		expect(autoSplitCeilingFor(settings, "bug_fix")).toBe(150);
		expect(autoSplitCeilingFor(settings, "hotfix")).toBe(100);
		expect(autoSplitCeilingFor(undefined, undefined)).toBe(400);
		expect(autoSplitCeilingFor(settings, "spike")).toBeUndefined();
		expect(autoSplitCeilingFor({ maxLinesByKind: { docs: 7 } }, "docs")).toBe(400);
	});

	it("reads a category as the backend does", () => {
		expect(kindFromCategory("bug_fix")).toBe("bug_fix");
		expect(kindFromCategory("documentation")).toBe("docs");
		expect(kindFromCategory("testing")).toBe("test");
		expect(kindFromCategory("infrastructure")).toBe("run");
		expect(kindFromCategory("security")).toBe("feature");
		expect(kindFromCategory("")).toBe("feature");
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

describe("following the parts' PRs", () => {
	const pr = "https://github.com/acme/shop/pull/12";

	it("watches a local part with a PR, waiting for review", () => {
		const open = part("012-oauth-part1", 1, {
			status: "pr_created",
			metadata: { ...part("x", 1).metadata, prUrl: pr },
		});
		const reviewed = part("012-oauth-part2", 2, { status: "human_review", prUrl: pr });
		expect(partsAwaitingMerge([open, reviewed]).map((t) => t.id)).toEqual([
			"012-oauth-part1",
			"012-oauth-part2",
		]);
		expect(prUrlOf(open)).toBe(pr);
	});

	it("leaves out a part without a PR, a done or archived part, a whole task, a server card", () => {
		const noPr = part("012-oauth-part1", 1, { status: "pr_created" });
		const done = part("012-oauth-part2", 2, { status: "done", prUrl: pr });
		const archived = part("012-oauth-part3", 3, {
			status: "pr_created",
			prUrl: pr,
			metadata: { ...part("x", 3).metadata, archivedAt: "2026-11-08" },
		});
		const whole = { id: "020-x", specId: "020-x", status: "pr_created", prUrl: pr } as Task;
		const server = part("server:p:012-oauth-part1", 1, { status: "pr_created", prUrl: pr });
		expect(partsAwaitingMerge([noPr, done, archived, whole, server])).toEqual([]);
	});

	it("moves a part stacked on a done part of the same split, and only that one", () => {
		const first = part("012-oauth-part1", 1, { status: "done" });
		const stacked = part("012-oauth-part2", 2, {
			metadata: { ...part("x", 2).metadata, stackParent: "012-oauth-part1" },
		});
		const notYet = part("012-oauth-part3", 3, {
			metadata: { ...part("x", 3).metadata, stackParent: "012-oauth-part2" },
		});
		const otherSplit = {
			...part("020-x-part2", 2),
			metadata: {
				splitGroup: { parent: "020-x", index: 2, total: 2 },
				stackParent: "012-oauth-part1",
			},
		} as Task;
		expect(partsToMoveOntoBase([first, stacked, notYet, otherSplit]).map((t) => t.id)).toEqual([
			"012-oauth-part2",
		]);
	});
});

describe("split group colour", () => {
	// The same fixtures as tests/task_split/test_group_marks.py and the phone.
	it.each([
		["012-add-oauth", "green"],
		["001-x", "violet"],
		["abc", "orange"],
		["é-123", "blue"],
		["999-very-long-name-here", "orange"],
	])("%s is %s, as on the backend", (group, tone) => {
		expect(splitGroupTone(group)).toBe(tone);
		expect(SPLIT_GROUP_TONES).toContain(tone);
	});

	it("names a part's group by its split task, and the split task by itself", () => {
		expect(splitGroupId(part("012-oauth-part2", 2))).toBe("012-oauth");
		expect(
			splitGroupId({
				specId: "012-oauth",
				metadata: { splitGroup: { children: ["012-oauth-part1"] } },
			} as Task),
		).toBe("012-oauth");
		expect(splitGroupId({ specId: "001-x", metadata: {} } as Task)).toBeNull();
	});
});
