import { describe, expect, it } from "vitest";
import type { Task, TaskPriority } from "../../shared/types";
import { compareQueueOrder, orderQueue } from "./kanban-queue";

function makeTask(
	id: string,
	createdAt: string,
	priority?: TaskPriority,
): Task {
	return {
		id,
		specId: id,
		projectId: "proj",
		title: id,
		description: "",
		status: "queue",
		subtasks: [],
		logs: [],
		createdAt: new Date(createdAt),
		updatedAt: new Date(createdAt),
		metadata: priority ? { priority } : undefined,
	};
}

describe("orderQueue", () => {
	it("promotes the most urgent task before the oldest one", () => {
		const ordered = orderQueue([
			makeTask("old-low", "2026-01-01T00:00:00Z", "low"),
			makeTask("new-urgent", "2026-06-01T00:00:00Z", "urgent"),
			makeTask("mid-high", "2026-03-01T00:00:00Z", "high"),
		]);
		expect(ordered.map((t) => t.id)).toEqual([
			"new-urgent",
			"mid-high",
			"old-low",
		]);
	});

	it("falls back to FIFO within one priority band", () => {
		const ordered = orderQueue([
			makeTask("b", "2026-02-01T00:00:00Z", "high"),
			makeTask("a", "2026-01-01T00:00:00Z", "high"),
			makeTask("c", "2026-03-01T00:00:00Z", "high"),
		]);
		expect(ordered.map((t) => t.id)).toEqual(["a", "b", "c"]);
	});

	it("keeps pure FIFO when no task carries a priority", () => {
		const ordered = orderQueue([
			makeTask("third", "2026-03-01T00:00:00Z"),
			makeTask("first", "2026-01-01T00:00:00Z"),
			makeTask("second", "2026-02-01T00:00:00Z"),
		]);
		expect(ordered.map((t) => t.id)).toEqual(["first", "second", "third"]);
	});

	it("ranks an unset priority below every explicit level", () => {
		const ordered = orderQueue([
			makeTask("none", "2026-01-01T00:00:00Z"),
			makeTask("low", "2026-06-01T00:00:00Z", "low"),
		]);
		expect(ordered.map((t) => t.id)).toEqual(["low", "none"]);
	});

	it("does not mutate the input array", () => {
		const tasks = [
			makeTask("b", "2026-02-01T00:00:00Z"),
			makeTask("a", "2026-01-01T00:00:00Z"),
		];
		orderQueue(tasks);
		expect(tasks.map((t) => t.id)).toEqual(["b", "a"]);
	});

	it("orders string dates coming from IPC the same way", () => {
		const a = makeTask("a", "2026-01-01T00:00:00Z");
		const b = makeTask("b", "2026-02-01T00:00:00Z");
		// Tasks rehydrated from IPC carry ISO strings, not Date instances.
		(a as unknown as { createdAt: string }).createdAt =
			"2026-01-01T00:00:00Z";
		(b as unknown as { createdAt: string }).createdAt =
			"2026-02-01T00:00:00Z";
		expect(compareQueueOrder(a, b)).toBeLessThan(0);
	});
});
