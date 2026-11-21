/**
 * Pixel Office seasons: three-month team goals, and the office decor they
 * leave behind.
 *
 * A season is a calendar quarter (local time). Its goals count normalized,
 * dated facts of the project (tasks delivered, QA passed on the first review,
 * refactoring delivered, incidents resolved, a second engine agreeing), the
 * same on every provider. A goal met in any season earns its decor for good:
 * the decor is computed from the facts themselves, so it needs no storage and
 * comes back on another machine that reads the same project.
 */

import type { Task } from "../../shared/types/task";
import type { IncidentFact } from "./pixel-office-achievements";

export const SEASON_GOAL_IDS = [
	"ship",
	"qa-first-try",
	"debt",
	"incidents",
	"second-opinion",
] as const;

export type SeasonGoalId = (typeof SEASON_GOAL_IDS)[number];

/** The cosmetic each goal unlocks, drawn in the office (`office-decor.ts`). */
export const DECOR_IDS = [
	"trophy-shelf",
	"plants",
	"whiteboard",
	"neon-sign",
	"arcade",
] as const;

export type DecorId = (typeof DECOR_IDS)[number];

export interface SeasonGoal {
	readonly id: SeasonGoalId;
	readonly target: number;
	readonly reward: DecorId;
}

export const SEASON_GOALS: readonly SeasonGoal[] = [
	{ id: "ship", target: 30, reward: "trophy-shelf" },
	{ id: "qa-first-try", target: 10, reward: "plants" },
	{ id: "debt", target: 5, reward: "whiteboard" },
	{ id: "incidents", target: 3, reward: "neon-sign" },
	{ id: "second-opinion", target: 5, reward: "arcade" },
];

/** When each counted fact happened, in ms, per goal. */
export type SeasonFacts = Record<SeasonGoalId, number[]>;

export interface Season {
	/** `2026-Q4`. */
	readonly id: string;
	readonly year: number;
	/** 1 to 4. */
	readonly quarter: number;
	/** First instant of the season. */
	readonly start: Date;
	/** First instant of the next season. */
	readonly end: Date;
}

export function seasonOf(at: Date): Season {
	const year = at.getFullYear();
	const index = Math.floor(at.getMonth() / 3);
	return {
		id: `${year}-Q${index + 1}`,
		year,
		quarter: index + 1,
		start: new Date(year, index * 3, 1),
		end: new Date(year, index * 3 + 3, 1),
	};
}

const SHIPPED = new Set<Task["status"]>(["done", "pr_created"]);

function timeOf(task: Task): number {
	return new Date(task.updatedAt).getTime();
}

function datesOf(tasks: readonly Task[], keep: (task: Task) => boolean): number[] {
	return tasks
		.filter(keep)
		.map(timeOf)
		.filter((at) => Number.isFinite(at));
}

/**
 * The dated facts the goals count. A task's fact is dated by its last
 * change, as the weekly achievement reads it; an incident by its resolution,
 * and one without a valid date is not counted in any season.
 */
export function collectSeasonFacts(
	tasks: readonly Task[],
	incidents: readonly IncidentFact[],
): SeasonFacts {
	const shipped = (t: Task) => SHIPPED.has(t.status);
	return {
		ship: datesOf(tasks, shipped),
		"qa-first-try": datesOf(
			tasks,
			(t) => t.qaSignoff?.status === "approved" && t.qaSignoff.session === 1,
		),
		debt: datesOf(
			tasks,
			(t) =>
				shipped(t) &&
				(t.metadata?.kind === "refactoring" ||
					t.metadata?.category === "refactoring"),
		),
		incidents: incidents
			.filter((i) => i.status === "resolved" && i.resolvedAt !== undefined)
			.map((i) => i.resolvedAt as number),
		"second-opinion": datesOf(tasks, (t) => t.crossReview?.verdict === "agree"),
	};
}

export interface GoalProgress {
	readonly goal: SeasonGoal;
	readonly count: number;
	readonly done: boolean;
}

/** Where each goal of a season stands. */
export function seasonProgress(
	facts: SeasonFacts,
	season: Season,
): GoalProgress[] {
	const from = season.start.getTime();
	const to = season.end.getTime();
	return SEASON_GOALS.map((goal) => {
		const count = facts[goal.id].filter((at) => at >= from && at < to).length;
		return { goal, count, done: count >= goal.target };
	});
}

/**
 * The decor earned so far, with the season that first earned it: a goal met
 * in any season up to `now` (facts dated later are ignored).
 */
export function earnedDecor(
	facts: SeasonFacts,
	now: Date,
): Partial<Record<DecorId, string>> {
	const earned: Partial<Record<DecorId, string>> = {};
	const limit = now.getTime();
	for (const goal of SEASON_GOALS) {
		const perSeason = new Map<string, number>();
		for (const at of [...facts[goal.id]].sort((a, b) => a - b)) {
			if (at > limit) break;
			const id = seasonOf(new Date(at)).id;
			const count = (perSeason.get(id) ?? 0) + 1;
			perSeason.set(id, count);
			if (count >= goal.target) {
				earned[goal.reward] = id;
				break;
			}
		}
	}
	return earned;
}
