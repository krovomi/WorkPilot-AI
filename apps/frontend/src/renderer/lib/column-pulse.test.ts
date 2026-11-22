/**
 * The one-line summary of each column, computed from its cards.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../shared/types";
import { columnPulse, startOfWeek } from "./column-pulse";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "t",
		specId: "s",
		projectId: "p",
		title: "Task",
		description: "",
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00"),
		updatedAt: new Date("2026-11-01T10:00:00"),
		...overrides,
	} as Task;
}

const priority = (p: string) => task({ metadata: { priority: p } } as Partial<Task>);
const phase = (p: string) =>
	task({ executionProgress: { phase: p, phaseProgress: 0, overallProgress: 0 } } as Partial<Task>);

describe("startOfWeek", () => {
	it("is the Monday at midnight of the same week, Sunday included", () => {
		expect(startOfWeek(new Date(2026, 10, 22, 15, 30))).toEqual(new Date(2026, 10, 16));
		expect(startOfWeek(new Date(2026, 10, 16, 0, 1))).toEqual(new Date(2026, 10, 16));
		expect(startOfWeek(new Date(2026, 10, 18, 9))).toEqual(new Date(2026, 10, 16));
	});
});

describe("columnPulse", () => {
	it("says nothing about an empty column or one without a summary", () => {
		expect(columnPulse("backlog", [])).toEqual([]);
		expect(columnPulse("ai_review", [task()])).toEqual([]);
		expect(columnPulse("backlog", [priority("low")])).toEqual([]);
	});

	it("counts urgent cards as a warning, then high priority ones", () => {
		expect(
			columnPulse("backlog", [priority("urgent"), priority("high"), priority("high"), task()]),
		).toEqual([
			{ key: "urgent", values: { count: 1 }, warn: true },
			{ key: "high", values: { count: 2 } },
		]);
	});

	it("names the next card of the queue before its priorities", () => {
		expect(columnPulse("queue", [task({ title: "Ship it" }), priority("high")])).toEqual([
			{ key: "next", values: { title: "Ship it" } },
			{ key: "high", values: { count: 1 } },
		]);
	});

	it("tells where the running cards are, a pause as a warning", () => {
		expect(
			columnPulse("in_progress", [
				phase("coding"),
				phase("coding"),
				phase("qa_review"),
				phase("qa_fixing"),
				phase("rate_limit_paused"),
				phase("planning"),
				task(),
			]),
		).toEqual([
			{ key: "planning", values: { count: 1 } },
			{ key: "coding", values: { count: 2 } },
			{ key: "qa", values: { count: 2 } },
			{ key: "paused", values: { count: 1 }, warn: true },
		]);
		expect(columnPulse("in_progress", [task()])).toEqual([]);
	});

	it("splits the review column into plans, reads and fixes", () => {
		expect(
			columnPulse("human_review", [
				task({ reviewReason: "plan_review" }),
				task({ reviewReason: "completed" }),
				task(),
				task({ reviewReason: "qa_rejected" }),
				task({ status: "error" as TaskStatus }),
			]),
		).toEqual([
			{ key: "plansToApprove", values: { count: 1 } },
			{ key: "toReview", values: { count: 2 } },
			{ key: "needsFix", values: { count: 2 }, warn: true },
		]);
		expect(columnPulse("human_review", [task({ reviewReason: "plan_review" })])).toEqual([
			{ key: "plansToApprove", values: { count: 1 } },
		]);
		expect(columnPulse("human_review", [task({ reviewReason: "completed" })])).toEqual([
			{ key: "toReview", values: { count: 1 } },
		]);
	});

	it("counts the cards done since Monday", () => {
		const now = new Date(2026, 10, 22, 12);
		const done = [
			task({ updatedAt: new Date(2026, 10, 16, 8) }),
			task({ updatedAt: new Date(2026, 10, 21) }),
			task({ updatedAt: new Date(2026, 10, 15, 23) }),
		];
		expect(columnPulse("done", done, { now })).toEqual([
			{ key: "doneThisWeek", values: { count: 2 } },
		]);
		expect(columnPulse("done", [done[2]], { now })).toEqual([]);
		expect(columnPulse("done", [task({ updatedAt: new Date() })])).toEqual([
			{ key: "doneThisWeek", values: { count: 1 } },
		]);
	});
});
