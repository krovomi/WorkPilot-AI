import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../../shared/types";
import { countRunning, groupMoveTargets, planGroupMove } from "../group-move";

const card = (id: string, status: TaskStatus, metadata: Task["metadata"] = {}) =>
	({ id, status, metadata }) as Task;

const plan = (...args: Parameters<typeof planGroupMove>) => {
	const result = planGroupMove(...args);
	return { ...result, moves: result.moves.map((m) => [m.task.id, m.to]) };
};

describe("planGroupMove", () => {
	it("moves every card that is not already in the target column", () => {
		expect(plan([card("a", "backlog"), card("b", "queue"), card("c", "done")], "done", 0)).toEqual({
			moves: [["a", "done"], ["b", "done"]],
			skipped: 1,
			queued: 0,
		});
	});

	it("counts an error card as already in Human Review", () => {
		expect(plan([card("a", "error")], "human_review", 0)).toMatchObject({ moves: [], skipped: 1 });
	});

	it("leaves out of PR Open a card that has no pull request", () => {
		expect(
			plan([card("a", "human_review", { prUrl: "https://x/pr/1" }), card("b", "human_review")], "pr_created", 0),
		).toEqual({ moves: [["a", "pr_created"]], skipped: 1, queued: 0 });
	});

	it("starts what the free slots allow, queues the rest, and leaves queued cards waiting", () => {
		expect(
			plan([card("a", "backlog"), card("b", "backlog"), card("c", "queue"), card("d", "ai_review")], "in_progress", 1),
		).toEqual({ moves: [["a", "in_progress"], ["b", "queue"], ["d", "queue"]], skipped: 0, queued: 3 });
	});

	it("treats a full board (negative free slots) as no slot", () => {
		expect(plan([card("a", "backlog")], "in_progress", -2)).toEqual({
			moves: [["a", "queue"]],
			skipped: 0,
			queued: 1,
		});
	});
});

describe("countRunning", () => {
	it("counts the cards in progress that are not archived", () => {
		expect(
			countRunning([
				card("a", "in_progress"),
				card("b", "in_progress", { archivedAt: "2026-11-22" } as Task["metadata"]),
				card("c", "queue"),
			]),
		).toBe(1);
	});
});

describe("groupMoveTargets", () => {
	it("lists the columns that take at least one card of the selection", () => {
		const targets = groupMoveTargets([card("a", "backlog"), card("b", "done")]);
		expect(targets.has("backlog")).toBe(true);
		expect(targets.has("done")).toBe(true);
		expect(targets.has("pr_created")).toBe(false);
	});
});
