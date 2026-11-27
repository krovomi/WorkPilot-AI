import { describe, expect, it } from "vitest";
import type { Sprint, Task } from "../../types";
import {
	activeSprint,
	cleanDay,
	cleanSprintDraft,
	orderedSprints,
	readSprints,
	sprintProgress,
	taskPoints,
	velocity,
} from "../sprints";

function sprint(overrides: Partial<Sprint>): Sprint {
	return { id: "sp-00000001", name: "S", state: "planned", createdAt: "2026-11-01T00:00:00Z", ...overrides };
}

function task(sprintId: string | undefined, status: Task["status"], score?: number): Task {
	return {
		id: `${sprintId}-${status}-${score}`,
		status,
		metadata: { sprintId, smartEstimate: score === undefined ? undefined : { complexityScore: score } },
	} as unknown as Task;
}

describe("sprint drafts", () => {
	it("keeps a clean draft and trims its name", () => {
		expect(cleanSprintDraft({ name: "  Sprint 1 ", goal: "Ship\nit", startDate: "2026-12-01", endDate: "2026-12-14" })).toEqual({
			name: "Sprint 1",
			goal: "Ship\nit",
			startDate: "2026-12-01",
			endDate: "2026-12-14",
		});
	});

	it.each([
		[null],
		[{ name: "" }],
		[{ name: "   " }],
		[{ name: "x".repeat(81) }],
		[{ name: "two\nlines" }],
		[{ name: "S", goal: "x".repeat(501) }],
		[{ name: "S", goal: "bell\u0007" }],
		[{ name: "S", id: "../../etc" }],
		[{ name: "S", startDate: "2026-02-30" }],
		[{ name: "S", startDate: "2026-12-10", endDate: "2026-12-01" }],
	])("refuses %j", (raw) => {
		expect(cleanSprintDraft(raw)).toBeNull();
	});

	it("reads only calendar days", () => {
		expect(cleanDay("2028-02-29")).toBe("2028-02-29");
		expect(cleanDay("2027-02-29")).toBeNull();
		expect(cleanDay("12/01/2026")).toBeNull();
	});
});

describe("readSprints", () => {
	it("leaves out malformed and repeated entries", () => {
		const good = sprint({ id: "sp-0000000a", state: "closed", report: { done: 1, donePoints: 3, carried: 0, carriedPoints: 0, carriedTo: "x" } as never });
		const read = readSprints({
			sprints: [good, { ...good }, { id: "bad", name: "x", state: "planned", createdAt: "t" }, sprint({ id: "sp-0000000b", state: "odd" as never }), "text"],
		});
		expect(read.map((s) => s.id)).toEqual(["sp-0000000a"]);
		expect(read[0].report?.carriedTo).toBeNull();
		expect(readSprints("nope")).toEqual([]);
	});
});

describe("points and progress", () => {
	it("counts a card's estimate, capped at 13", () => {
		expect(taskPoints(task("s", "done", 5))).toBe(5);
		expect(taskPoints(task("s", "done", 40))).toBe(13);
		expect(taskPoints(task("s", "done"))).toBe(0);
	});

	it("sums one sprint's cards", () => {
		const tasks = [task("sp-1", "done", 3), task("sp-1", "in_progress", 5), task("sp-1", "backlog"), task("sp-2", "done", 8)];
		expect(sprintProgress(tasks, "sp-1")).toEqual({ cards: 3, done: 1, points: 8, donePoints: 3, unestimated: 1 });
	});

	it("orders active, planned by start, closed latest first, and averages the last three closed", () => {
		const list = [
			sprint({ id: "sp-c1", state: "closed", closedAt: "2026-10-01", report: { done: 1, donePoints: 10, carried: 0, carriedPoints: 0, carriedTo: null } }),
			sprint({ id: "sp-p2", startDate: "2026-12-20" }),
			sprint({ id: "sp-a", state: "active" }),
			sprint({ id: "sp-p1", startDate: "2026-12-01" }),
			sprint({ id: "sp-c2", state: "closed", closedAt: "2026-11-01", report: { done: 1, donePoints: 20, carried: 0, carriedPoints: 0, carriedTo: null } }),
		];
		expect(orderedSprints(list).map((s) => s.id)).toEqual(["sp-a", "sp-p1", "sp-p2", "sp-c2", "sp-c1"]);
		expect(activeSprint(list)?.id).toBe("sp-a");
		expect(velocity(list)).toBe(15);
		expect(velocity([sprint({})])).toBeNull();
	});
});
