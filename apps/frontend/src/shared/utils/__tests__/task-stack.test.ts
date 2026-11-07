/**
 * Stacking rules without I/O (F6): only a pending blocker can be the parent,
 * never in a loop; once the parent is merged the child targets its base, and
 * stays stacked when that base is itself a task's branch.
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import {
	afterParentMerged,
	isSafeBranch,
	stackMetadata,
	stackRefusal,
} from "../task-stack";

function task(id: string, metadata: Record<string, unknown> = {}, status = "backlog"): Task {
	return { id, specId: id, status, title: id, metadata } as unknown as Task;
}

describe("stackRefusal", () => {
	const a = task("001-a");
	const b = task("002-b", { blockedBy: ["001-a"] });

	it("accepts a pending blocker", () => {
		expect(stackRefusal(b, a, [a, b])).toBeNull();
	});

	it("refuses the task itself, a non-blocker, a done parent and a second stack", () => {
		expect(stackRefusal(b, b, [b])).toBe("same_task");
		expect(stackRefusal(task("003-c"), a, [a])).toBe("not_blocker");
		expect(stackRefusal(b, task("001-a", {}, "done"), [b])).toBe("parent_done");
		expect(stackRefusal(task("002-b", { blockedBy: ["001-a"], stackParent: "001-a" }), a, [a])).toBe(
			"already_stacked",
		);
	});

	it("refuses a loop through the parent's blockers or its own stack", () => {
		const viaBlockers = task("001-a", { blockedBy: ["000-z"] });
		const z = task("000-z", { blockedBy: ["002-b"] });
		expect(stackRefusal(b, viaBlockers, [viaBlockers, z, b])).toBe("cycle");
		const viaStack = task("001-a", { stackParent: "002-b" });
		expect(stackRefusal(b, viaStack, [viaStack, b])).toBe("cycle");
	});
});

describe("stack metadata", () => {
	it("starts the child from the parent's local branch", () => {
		expect(stackMetadata("001-a", "a".repeat(40), "develop")).toEqual({
			baseBranch: "workpilot/001-a",
			useLocalBranch: true,
			stackParent: "001-a",
			stackParentSha: "a".repeat(40),
			stackTrunk: "develop",
		});
	});

	it("unstacks onto a trunk and re-stacks onto a grandparent", () => {
		expect(afterParentMerged("develop", "b".repeat(40), "develop")).toEqual({
			baseBranch: "develop",
			useLocalBranch: null,
			stackParent: null,
			stackParentSha: null,
			stackTrunk: null,
		});
		expect(afterParentMerged("workpilot/000-z", "c".repeat(40), "main")).toMatchObject({
			stackParent: "000-z",
			stackParentSha: "c".repeat(40),
			stackTrunk: "main",
		});
	});

	it.each(["main", "release/1.2", "workpilot/001-a"])("accepts branch %s", (name) => {
		expect(isSafeBranch(name)).toBe(true);
	});

	it.each(["", "-x", "a..b", "a/", "x.lock", "a b", "a;b", 42])("refuses branch %j", (name) => {
		expect(isSafeBranch(name)).toBe(false);
	});
});
