import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../shared/types";
import {
	eligibleBlockers,
	indexTasksById,
	isBlocked,
	resolveBlockers,
	wouldCreateCycle,
} from "./kanban-dependencies";

function makeTask(
	id: string,
	status: TaskStatus = "queue",
	blockedBy?: string[],
	extra?: { archivedAt?: string; abandoned?: boolean },
): Task {
	const now = new Date("2026-01-01T00:00:00Z");
	return {
		id,
		specId: id,
		projectId: "proj",
		title: `Task ${id}`,
		description: "",
		status,
		subtasks: [],
		logs: [],
		createdAt: now,
		updatedAt: now,
		metadata: { ...(blockedBy ? { blockedBy } : {}), ...extra },
	};
}

describe("resolveBlockers", () => {
	it("splits blockers into pending, resolved and missing", () => {
		const task = makeTask("a", "queue", ["done-one", "running", "ghost"]);
		const byId = indexTasksById([
			task,
			makeTask("done-one", "done"),
			makeTask("running", "in_progress"),
		]);

		const state = resolveBlockers(task, byId);
		expect(state.resolved.map((t) => t.id)).toEqual(["done-one"]);
		expect(state.pending.map((t) => t.id)).toEqual(["running"]);
		expect(state.missing).toEqual(["ghost"]);
	});

	it("treats pr_created as satisfied", () => {
		const task = makeTask("a", "queue", ["shipped"]);
		const byId = indexTasksById([task, makeTask("shipped", "pr_created")]);
		expect(isBlocked(task, byId)).toBe(false);
	});

	it("does not block on a missing blocker", () => {
		const task = makeTask("a", "queue", ["deleted"]);
		expect(isBlocked(task, indexTasksById([task]))).toBe(false);
	});

	it("does not block on an abandoned or archived blocker", () => {
		const task = makeTask("a", "queue", ["given-up", "filed-away"]);
		const byId = indexTasksById([
			task,
			makeTask("given-up", "backlog", undefined, { abandoned: true }),
			makeTask("filed-away", "backlog", undefined, {
				archivedAt: "2026-01-02T00:00:00Z",
			}),
		]);
		expect(isBlocked(task, byId)).toBe(false);
	});

	it("ignores a self-reference", () => {
		const task = makeTask("a", "queue", ["a"]);
		const state = resolveBlockers(task, indexTasksById([task]));
		expect(state).toEqual({ pending: [], resolved: [], missing: [] });
	});

	it("reports no blockers when the field is absent", () => {
		const task = makeTask("a");
		expect(isBlocked(task, indexTasksById([task]))).toBe(false);
	});
});

describe("wouldCreateCycle", () => {
	it("rejects a direct loop", () => {
		const a = makeTask("a", "queue", ["b"]);
		const b = makeTask("b");
		expect(wouldCreateCycle("b", "a", indexTasksById([a, b]))).toBe(true);
	});

	it("rejects a transitive loop", () => {
		// a blocked by b, b blocked by c — adding a as blocker of c closes it.
		const a = makeTask("a", "queue", ["b"]);
		const b = makeTask("b", "queue", ["c"]);
		const c = makeTask("c");
		expect(wouldCreateCycle("c", "a", indexTasksById([a, b, c]))).toBe(true);
	});

	it("rejects self-blocking", () => {
		const a = makeTask("a");
		expect(wouldCreateCycle("a", "a", indexTasksById([a]))).toBe(true);
	});

	it("accepts an edge that closes nothing", () => {
		const a = makeTask("a", "queue", ["b"]);
		const b = makeTask("b");
		const c = makeTask("c");
		expect(wouldCreateCycle("a", "c", indexTasksById([a, b, c]))).toBe(false);
	});

	it("terminates on a pre-existing loop in the data", () => {
		const a = makeTask("a", "queue", ["b"]);
		const b = makeTask("b", "queue", ["a"]);
		expect(wouldCreateCycle("c", "a", indexTasksById([a, b]))).toBe(false);
	});
});

describe("eligibleBlockers", () => {
	it("excludes self, existing blockers, archived tasks and cycles", () => {
		const a = makeTask("a", "queue", ["b"]);
		const b = makeTask("b");
		const archived = makeTask("arch", "done", undefined, {
			archivedAt: "2026-01-02T00:00:00Z",
		});
		const free = makeTask("free");

		const ids = eligibleBlockers(b, [a, b, archived, free]).map((t) => t.id);
		expect(ids).toEqual(["free"]);
	});
});
