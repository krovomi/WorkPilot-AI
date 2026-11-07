import { describe, expect, it } from "vitest";
import type { ReviewReason, TaskStatus } from "../../../shared/types";
import { progressOf, repoStatusFromTask, waitsForSomeone } from "../task-outcome";

describe("repoStatusFromTask", () => {
	it.each<[TaskStatus, ReviewReason | undefined, string]>([
		["backlog", undefined, "pending"],
		["queue", undefined, "pending"],
		["in_progress", undefined, "coding"],
		["ai_review", undefined, "qa"],
		["human_review", "completed", "completed"],
		["human_review", "stopped", "pending"],
		["human_review", "plan_review", "needs_you"],
		["human_review", "qa_rejected", "needs_you"],
		["human_review", "errors", "needs_you"],
		["human_review", undefined, "needs_you"],
		["done", undefined, "completed"],
		["pr_created", undefined, "completed"],
		["build_failed", undefined, "needs_you"],
		["error", undefined, "failed"],
	])("%s / %s → %s", (status, reason, expected) => {
		expect(repoStatusFromTask(status, reason)).toBe(expected);
	});
});

describe("progressOf / waitsForSomeone", () => {
	it("keeps the progress where a person has to act", () => {
		expect(progressOf("coding", 0)).toBe(50);
		expect(progressOf("needs_you", 80)).toBe(80);
		expect(progressOf("completed", 80)).toBe(100);
		expect(waitsForSomeone("needs_you")).toBe(true);
		expect(waitsForSomeone("failed")).toBe(true);
		expect(waitsForSomeone("qa")).toBe(false);
	});
});
