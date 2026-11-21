import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types/task";
import {
	ACHIEVEMENT_IDS,
	collectFacts,
	earnedAchievements,
	incidentFactsOf,
	type OfficeFacts,
} from "../pixel-office-achievements";

const NOW = new Date("2026-11-16T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

function task(overrides: Partial<Task>): Task {
	return {
		id: "t",
		specId: "t",
		projectId: "p",
		title: "t",
		description: "",
		status: "in_progress",
		subtasks: [],
		logs: [],
		createdAt: new Date(NOW - DAY),
		updatedAt: new Date(NOW),
		...overrides,
	};
}

const NO_FACTS: OfficeFacts = {
	shippedAt: [],
	qaFirstTry: 0,
	incidentsResolved: 0,
	incidentsFixedByAgent: 0,
	reviewsAgreed: 0,
};

describe("incidentFactsOf", () => {
	it("keeps the status and a non-empty fix URL of each incident", () => {
		expect(
			incidentFactsOf([
				{ status: "resolved", fix_pr_url: "https://forge/pr/1", title: "x" },
				{ status: "resolved", fix_pr_url: "" },
				{ status: "pending", fix_pr_url: 7 },
			]),
		).toEqual([
			{ status: "resolved", fixPrUrl: "https://forge/pr/1" },
			{ status: "resolved" },
			{ status: "pending" },
		]);
	});

	it("drops what is not an incident", () => {
		expect(incidentFactsOf(null)).toEqual([]);
		expect(incidentFactsOf({ status: "resolved" })).toEqual([]);
		expect(incidentFactsOf([null, "resolved", { status: 1 }, {}])).toEqual([]);
	});
});

describe("collectFacts", () => {
	it("reads shipped tasks, first-try QA, agreed reviews and resolved incidents", () => {
		const facts = collectFacts(
			[
				task({ status: "done", updatedAt: new Date(NOW - DAY) }),
				task({ status: "pr_created", updatedAt: new Date(NOW) }),
				task({ status: "done", updatedAt: new Date("not a date") }),
				task({ status: "human_review" }),
				task({ qaSignoff: { status: "approved", session: 1 } }),
				task({ qaSignoff: { status: "approved", session: 2 } }),
				task({ qaSignoff: { status: "rejected", session: 1 } }),
				task({
					crossReview: { verdict: "agree", provider: "ollama", model: "m", blockers: 0 },
				}),
				task({
					crossReview: { verdict: "disagree", provider: "openai", model: "m", blockers: 1 },
				}),
			],
			[
				{ status: "resolved", fixPrUrl: "https://forge/pr/2" },
				{ status: "resolved" },
				{ status: "escalated", fixPrUrl: "https://forge/pr/3" },
			],
		);
		expect(facts).toEqual({
			shippedAt: [NOW - DAY, NOW],
			qaFirstTry: 1,
			incidentsResolved: 2,
			incidentsFixedByAgent: 1,
			reviewsAgreed: 1,
		});
	});
});

describe("earnedAchievements", () => {
	it("earns nothing from nothing", () => {
		expect(earnedAchievements(NO_FACTS, NOW)).toEqual([]);
	});

	it("earns every achievement, in catalog order, when every threshold is met", () => {
		const facts: OfficeFacts = {
			shippedAt: Array.from({ length: 10 }, (_, i) => NOW - i * 60_000),
			qaFirstTry: 5,
			incidentsResolved: 1,
			incidentsFixedByAgent: 1,
			reviewsAgreed: 1,
		};
		expect(earnedAchievements(facts, NOW)).toEqual([...ACHIEVEMENT_IDS]);
	});

	it("counts only the last seven days for the busy week, and nothing after now", () => {
		const nine = Array.from({ length: 9 }, () => NOW - DAY);
		const old = NOW - 8 * DAY;
		const future = NOW + DAY;
		expect(
			earnedAchievements({ ...NO_FACTS, shippedAt: [...nine, old, future] }, NOW),
		).toEqual(["first-ship"]);
		expect(
			earnedAchievements({ ...NO_FACTS, shippedAt: [...nine, NOW - 7 * DAY] }, NOW),
		).toEqual(["first-ship", "ten-ships-week"]);
	});

	it("needs five first-try passes for the steady hand", () => {
		expect(earnedAchievements({ ...NO_FACTS, qaFirstTry: 4 }, NOW)).toEqual([
			"qa-first-try",
		]);
	});
});
