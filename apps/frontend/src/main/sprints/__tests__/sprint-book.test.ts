import { describe, expect, it } from "vitest";
import type { Sprint } from "../../../shared/types/sprint";
import { cleanCommitment, cleanReport, completeSprint, deleteSprint, newSprintId, saveSprint, startSprint } from "../sprint-book";

const NOW = "2026-11-27T10:00:00.000Z";

function sprints(outcome: ReturnType<typeof saveSprint>): Sprint[] {
	if ("error" in outcome) throw new Error(outcome.error);
	return outcome.sprints;
}

describe("sprint book", () => {
	it("plans, starts and closes a sprint", () => {
		let list = sprints(saveSprint([], { name: "S1" }, NOW, "sp-00000001"));
		list = sprints(saveSprint(list, { name: "S2" }, NOW, "sp-00000002"));
		expect(list[0]).toMatchObject({ id: "sp-00000001", state: "planned", createdAt: NOW });

		list = sprints(saveSprint(list, { id: "sp-00000001", name: "S1b", goal: "Ship" }, NOW));
		expect(list[0]).toMatchObject({ name: "S1b", goal: "Ship" });

		list = sprints(startSprint(list, "sp-00000001", { cards: 3, points: 8 }, NOW));
		expect(list[0]).toMatchObject({ state: "active", committed: { cards: 3, points: 8 }, startedAt: NOW });
		expect(startSprint(list, "sp-00000002", { cards: 0, points: 0 }, NOW)).toEqual({ error: "another_active" });

		const report = { done: 2, donePoints: 5, carried: 1, carriedPoints: 3, carriedTo: "sp-00000002" };
		expect(completeSprint(list, "sp-00000001", { ...report, carriedTo: "sp-00000001" }, NOW)).toEqual({ error: "bad_target" });
		list = sprints(completeSprint(list, "sp-00000001", report, NOW));
		expect(list[0]).toMatchObject({ state: "closed", closedAt: NOW, report });

		expect(saveSprint(list, { id: "sp-00000001", name: "again" }, NOW)).toEqual({ error: "closed" });
		expect(deleteSprint(list, "sp-00000001")).toEqual({ error: "not_planned" });
		expect(deleteSprint(list, "sp-00000002")).toEqual({ sprints: [list[0]] });
	});

	it("refuses what the renderer may not send", () => {
		expect(saveSprint([], { name: "" }, NOW)).toEqual({ error: "invalid" });
		expect(saveSprint([], { id: "sp-0000ffff", name: "x" }, NOW)).toEqual({ error: "not_found" });
		expect(startSprint([], "../x", { cards: 1, points: 1 }, NOW)).toEqual({ error: "invalid" });
		expect(deleteSprint([], 42)).toEqual({ error: "invalid" });
		expect(cleanCommitment({ cards: -1, points: 0 })).toBeNull();
		expect(cleanCommitment({ cards: 1.5, points: 0 })).toBeNull();
		expect(cleanReport({ done: 1, donePoints: 1, carried: 0, carriedPoints: 0, carriedTo: "elsewhere" })).toBeNull();
		expect(cleanReport({ done: 1, donePoints: 1e9, carried: 0, carriedPoints: 0 })).toBeNull();
		expect(newSprintId()).toMatch(/^sp-[0-9a-f]{8}$/);
		expect(cleanCommitment("3")).toBeNull();
		expect(cleanReport(null)).toBeNull();
	});

	it("refuses a sprint that is not there or not in the right state", () => {
		const planned: Sprint = { id: "sp-00000001", name: "P", state: "planned", createdAt: NOW };
		const active: Sprint = { ...planned, id: "sp-00000002", state: "active" };
		const report = { done: 0, donePoints: 0, carried: 0, carriedPoints: 0, carriedTo: null };
		const full = Array.from({ length: 200 }, (_, i) => ({ ...planned, id: `sp-${i.toString(16).padStart(8, "0")}` }));
		expect(saveSprint(full, { name: "one more" }, NOW)).toEqual({ error: "too_many" });
		expect(startSprint([planned], "sp-0000ffff", { cards: 0, points: 0 }, NOW)).toEqual({ error: "not_found" });
		expect(startSprint([active], active.id, { cards: 0, points: 0 }, NOW)).toEqual({ error: "not_planned" });
		expect(completeSprint([active], active.id, { done: -1 }, NOW)).toEqual({ error: "invalid" });
		expect(completeSprint([active], "sp-0000ffff", report, NOW)).toEqual({ error: "not_found" });
		expect(completeSprint([planned], planned.id, report, NOW)).toEqual({ error: "not_active" });
		expect(deleteSprint([planned], "sp-0000ffff")).toEqual({ error: "not_found" });
	});
});
