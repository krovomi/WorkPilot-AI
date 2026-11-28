import { describe, expect, it } from "vitest";
import type { Sprint, Task } from "../../types";
import {
	activeSprint,
	cleanDay,
	cleanSprintDraft,
	orderedSprints,
	readSprints,
	sprintCapacity,
	sprintProgress,
	taskPoints,
	velocity,
	velocityHistory,
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

describe("edge cases of the stored sprints", () => {
	it("reads a bare list, counts, commitments and a carry target", () => {
		const read = readSprints([
			sprint({
				id: "sp-0000000d",
				state: "active",
				committed: { cards: "x" as never, points: 3.5 },
				report: { done: 1, donePoints: 1, carried: 1, carriedPoints: 1, carriedTo: "sp-0000000e" },
			}),
			{ ...sprint({ id: "sp-0000000f" }), createdAt: 12 },
		]);
		expect(read).toHaveLength(1);
		expect(read[0].committed).toEqual({ cards: 0, points: 0 });
		expect(read[0].report?.carriedTo).toBe("sp-0000000e");
		expect(cleanSprintDraft({ name: 3 })).toBeNull();
		expect(cleanSprintDraft({ name: "S", goal: "   " })).toEqual({ name: "S" });
	});

	it("orders and averages sprints that lack their dates", () => {
		const report = { done: 0, donePoints: 4, carried: 0, carriedPoints: 0, carriedTo: null };
		const list = [
			sprint({ id: "sp-c1", state: "closed", report }),
			sprint({ id: "sp-c2", state: "closed", closedAt: "2026-11-01", report }),
			sprint({ id: "sp-c3", state: "closed" }),
			sprint({ id: "sp-c4", state: "closed", report }),
			sprint({ id: "sp-p1", createdAt: "2026-11-02" }),
			sprint({ id: "sp-p2", startDate: "2026-11-01" }),
		];
		expect(orderedSprints(list).map((s) => s.id)).toEqual(["sp-p2", "sp-p1", "sp-c2", "sp-c1", "sp-c3", "sp-c4"]);
		expect(velocity(list)).toBe(4);
	});
});

describe("sprint capacity", () => {
	const closed = (id: string, closedAt: string, donePoints: number) =>
		sprint({ id, state: "closed", closedAt, report: { done: 1, donePoints, carried: 0, carriedPoints: 0, carriedTo: null } });

	it("keeps a capacity of whole points, clears it with null, and refuses anything else", () => {
		expect(cleanSprintDraft({ name: "S", capacity: 21 })).toEqual({ name: "S", capacity: 21 });
		expect(cleanSprintDraft({ name: "S", capacity: null })).toEqual({ name: "S", capacity: null });
		for (const capacity of [0, -3, 1000, 2.5, "12", Number.NaN]) {
			expect(cleanSprintDraft({ name: "S", capacity })).toBeNull();
		}
		const [read] = readSprints([{ ...sprint({}), capacity: 18 }, { ...sprint({ id: "sp-00000002" }), capacity: null }]);
		expect(read.capacity).toBe(18);
		expect(readSprints([{ ...sprint({ id: "sp-00000002" }), capacity: null }])[0]).not.toHaveProperty("capacity");
	});

	it("lists the last three closed sprints oldest first", () => {
		const list = [
			closed("sp-00000001", "2026-10-01", 10),
			closed("sp-00000002", "2026-10-15", 20),
			closed("sp-00000003", "2026-11-01", 30),
			closed("sp-00000004", "2026-11-15", 40),
			sprint({ id: "sp-00000005" }),
		];
		expect(velocityHistory(list).map((item) => item.report.donePoints)).toEqual([20, 30, 40]);
		expect(velocity(list)).toBe(30);
	});

	it("takes the sprint's own capacity, else the velocity, else the first-sprint target", () => {
		const history = [closed("sp-00000009", "2026-11-01", 24)];
		expect(sprintCapacity({ capacity: 18 }, history)).toEqual({ points: 18, source: "set", velocity: 24 });
		expect(sprintCapacity({}, history)).toEqual({ points: 24, source: "velocity", velocity: 24 });
		expect(sprintCapacity({}, [])).toEqual({ points: 20, source: "default", velocity: null });
		// A velocity of 0 (nothing done) is no capacity: the target stands.
		expect(sprintCapacity({}, [closed("sp-00000009", "2026-11-01", 0)]).source).toBe("default");
	});
});
