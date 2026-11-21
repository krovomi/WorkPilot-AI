/**
 * A season is a calendar quarter; its goals count dated facts inside it, and
 * a goal met in any season earns its decor for good.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types/task";
import {
	collectSeasonFacts,
	earnedDecor,
	SEASON_GOALS,
	type SeasonFacts,
	seasonOf,
	seasonProgress,
} from "../pixel-office-seasons";

function task(overrides: Partial<Task>): Task {
	return {
		id: "t",
		specId: "t",
		projectId: "p",
		title: "t",
		description: "",
		status: "done",
		subtasks: [],
		logs: [],
		createdAt: new Date(2026, 9, 1),
		updatedAt: new Date(2026, 10, 2),
		...overrides,
	};
}

const NONE: SeasonFacts = {
	ship: [],
	"qa-first-try": [],
	debt: [],
	incidents: [],
	"second-opinion": [],
};

describe("seasonOf", () => {
	it("is the calendar quarter of the date", () => {
		const season = seasonOf(new Date(2026, 10, 21));
		expect(season).toMatchObject({ id: "2026-Q4", year: 2026, quarter: 4 });
		expect(season.start).toEqual(new Date(2026, 9, 1));
		expect(season.end).toEqual(new Date(2027, 0, 1));
		expect(seasonOf(new Date(2026, 0, 1)).id).toBe("2026-Q1");
	});
});

describe("collectSeasonFacts", () => {
	it("dates each fact the goals count", () => {
		const at = new Date(2026, 10, 2).getTime();
		const facts = collectSeasonFacts(
			[
				task({}),
				task({ status: "pr_created", metadata: { kind: "refactoring" } }),
				task({ status: "done", metadata: { category: "refactoring" } }),
				task({ status: "in_progress", metadata: { kind: "refactoring" } }),
				task({ status: "human_review", qaSignoff: { status: "approved", session: 1 } }),
				task({ status: "human_review", qaSignoff: { status: "approved", session: 2 } }),
				task({ crossReview: { verdict: "agree" } as Task["crossReview"] }),
				task({ updatedAt: new Date("not a date") }),
			],
			[
				{ status: "resolved", resolvedAt: at },
				{ status: "resolved" },
				{ status: "open", resolvedAt: at },
			],
		);
		expect(facts.ship).toHaveLength(4);
		expect(facts.debt).toHaveLength(2);
		expect(facts["qa-first-try"]).toEqual([at]);
		expect(facts["second-opinion"]).toEqual([at]);
		expect(facts.incidents).toEqual([at]);
	});
});

describe("seasonProgress", () => {
	it("counts only the facts inside the season", () => {
		const season = seasonOf(new Date(2026, 10, 21));
		const inside = new Date(2026, 11, 31, 23).getTime();
		const before = new Date(2026, 8, 30).getTime();
		const after = new Date(2027, 0, 1).getTime();
		const progress = seasonProgress(
			{ ...NONE, incidents: [inside, inside, inside, before, after] },
			season,
		);
		expect(progress.map((p) => p.goal.id)).toEqual(SEASON_GOALS.map((g) => g.id));
		expect(progress.find((p) => p.goal.id === "incidents")).toMatchObject({
			count: 3,
			done: true,
		});
		expect(progress.find((p) => p.goal.id === "ship")).toMatchObject({
			count: 0,
			done: false,
		});
	});
});

describe("earnedDecor", () => {
	const q2 = (day: number) => new Date(2026, 4, day).getTime();
	const q3 = (day: number) => new Date(2026, 7, day).getTime();

	it("earns a goal's decor in the first season that met it", () => {
		const decor = earnedDecor(
			{ ...NONE, incidents: [q3(3), q2(1), q2(2), q2(3), q3(1), q3(2)] },
			new Date(2026, 10, 21),
		);
		expect(decor).toEqual({ "neon-sign": "2026-Q2" });
	});

	it("does not add up seasons, nor read facts after now", () => {
		expect(
			earnedDecor({ ...NONE, incidents: [q2(1), q2(2), q3(1)] }, new Date(2026, 10, 21)),
		).toEqual({});
		expect(
			earnedDecor({ ...NONE, incidents: [q3(1), q3(2), q3(3)] }, new Date(2026, 7, 2)),
		).toEqual({});
	});
});
