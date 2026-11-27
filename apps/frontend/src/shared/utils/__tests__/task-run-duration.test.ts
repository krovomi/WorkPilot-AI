import { describe, expect, it } from "vitest";
import type { TaskStatusTransition } from "../../types/task";
import { durationParts, taskRunDurations } from "../task-run-duration";

const at = (minutes: number) =>
	new Date(Date.UTC(2026, 10, 27, 9, 0) + minutes * 60_000).toISOString();

function entry(
	to: TaskStatusTransition["to"],
	minutes: number,
	reason?: TaskStatusTransition["reason"],
): TaskStatusTransition {
	return { from: null, to, at: at(minutes), actor: "agent", ...(reason && { reason }) };
}

describe("taskRunDurations", () => {
	it("counts the agents' time, every run, and the time from launch to finish", () => {
		const history = [
			entry("backlog", 0),
			entry("in_progress", 10),
			entry("ai_review", 40),
			entry("human_review", 50, "qa_rejected"),
			// Waiting for the person does not count as agents' time.
			entry("in_progress", 110),
			entry("ai_review", 120),
			entry("human_review", 125, "completed"),
			entry("done", 200),
		];
		expect(taskRunDurations(history)).toEqual({
			agentMs: (40 + 15) * 60_000,
			leadMs: 190 * 60_000,
		});
	});

	it("counts a pull request opened or a completed review as finished", () => {
		const pr = [entry("in_progress", 0), entry("pr_created", 30)];
		expect(taskRunDurations(pr).leadMs).toBe(30 * 60_000);
		const review = [entry("in_progress", 0), entry("human_review", 20, "qa_unverified")];
		expect(taskRunDurations(review)).toEqual({ agentMs: 20 * 60_000, leadMs: 20 * 60_000 });
	});

	it("knows nothing without a history, a launch or a finish", () => {
		expect(taskRunDurations(undefined)).toEqual({});
		expect(taskRunDurations([])).toEqual({});
		expect(taskRunDurations([entry("backlog", 0), entry("done", 5)])).toEqual({});
		// Still working: the open stretch is not counted, and it is not finished.
		expect(taskRunDurations([entry("in_progress", 0)])).toEqual({});
	});

	it("skips dates it cannot read or that go backwards", () => {
		const broken: TaskStatusTransition[] = [
			{ ...entry("in_progress", 0), at: "not a date" },
			entry("done", 10),
		];
		expect(taskRunDurations(broken)).toEqual({});
		expect(taskRunDurations([entry("in_progress", 10), entry("done", 5)])).toEqual({});
	});
});

describe("durationParts", () => {
	it("says a duration in its largest whole units", () => {
		expect(durationParts(-5)).toEqual({ unit: "seconds", seconds: 0 });
		expect(durationParts(42_000)).toEqual({ unit: "seconds", seconds: 42 });
		expect(durationParts(12 * 60_000)).toEqual({ unit: "minutes", minutes: 12 });
		expect(durationParts(125 * 60_000)).toEqual({ unit: "hours", hours: 2, minutes: 5 });
		expect(durationParts((26 * 60 + 30) * 60_000)).toEqual({ unit: "days", days: 1, hours: 2 });
	});
});
