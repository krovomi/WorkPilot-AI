/**
 * The rules of « Proposer le sprint »: which cards are candidates, how they
 * rank, how they fill a sprint with what they wait on first, and what is left
 * below the capacity line.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskMetadata } from "../../../shared/types";
import {
	fill,
	goalWords,
	proposeByRules,
	rankCandidates,
	reasonOf,
	type RuleInput,
	targetPoints,
} from "../proposal-rules";

const NOW = new Date("2026-11-28T12:00:00Z").getTime();
const SPRINT = "sp-0000000a";

function card(id: string, points: number, metadata: Partial<TaskMetadata> = {}, extra: Partial<Task> = {}): Task {
	return {
		id,
		specId: `spec-${id}`,
		projectId: "p",
		title: `Card ${id}`,
		description: "",
		status: "backlog",
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-27T12:00:00Z"),
		updatedAt: new Date("2026-11-27T12:00:00Z"),
		metadata: {
			...(points > 0 ? { smartEstimate: { complexityScore: points } } : {}),
			...metadata,
		} as TaskMetadata,
		...extra,
	} as Task;
}

function input(tasks: Task[], extra: Partial<RuleInput> = {}): RuleInput {
	return { tasks, sprintId: SPRINT, capacity: 20, variant: "balanced", now: NOW, ...extra };
}

describe("goalWords", () => {
	it("keeps the longer words once, without accents or case", () => {
		expect(goalWords("Paiement, PAIEMENT et sécurité du site")).toEqual(["paiement", "securite", "site"]);
		expect(goalWords(undefined)).toEqual([]);
		expect(goalWords("")).toEqual([]);
	});
});

describe("rankCandidates", () => {
	it("offers only plannable backlog cards with points, and lists those without", () => {
		const pool = rankCandidates(
			input([
				card("a", 3),
				card("b", 0),
				card("c", 5, {}, { status: "done" }),
				card("d", 5, { abandoned: true }),
				card("e", 5, { archivedAt: "2026-11-01" } as Partial<TaskMetadata>),
				card("f", 5, { sprintId: SPRINT }),
			]),
		);
		expect(pool.candidates.map((candidate) => candidate.task.id)).toEqual(["a"]);
		expect(pool.unestimated).toEqual(["b"]);
	});

	it("ranks urgent, then bugs, then what unblocks, then the goal", () => {
		const pool = rankCandidates(
			input(
				[
					card("low", 3, { priority: "low" }),
					card("urgent", 3, { priority: "urgent" }),
					card("bug", 3, { category: "bug_fix" } as Partial<TaskMetadata>),
					card("key", 3),
					card("waits", 3, { priority: "low", blockedBy: ["key"] }),
					card("goal", 3, {}, { title: "Refaire le paiement", description: undefined }),
				],
				{ goal: "Paiement en ligne" },
			),
		);
		expect(pool.candidates.map((candidate) => candidate.task.id)).toEqual([
			"urgent",
			"bug",
			"goal",
			"key",
			"low",
			"waits",
		]);
		const key = pool.candidates.find((candidate) => candidate.task.id === "key");
		expect(key?.unblocks).toBe(1);
		const waits = pool.candidates.find((candidate) => candidate.task.id === "waits");
		expect(waits?.waitsOn).toEqual(["key"]);
	});

	it("leans on bugs or the goal for those variants", () => {
		const tasks = [
			card("high", 3, { priority: "high" }),
			card("bug", 3, { category: "bug_fix" } as Partial<TaskMetadata>),
			card("goal", 3, {}, { title: "Export PDF" }),
		];
		expect(rankCandidates(input(tasks, { variant: "bugs" })).candidates[0].task.id).toBe("bug");
		expect(rankCandidates(input(tasks, { variant: "goal", goal: "export" })).candidates[0].task.id).toBe("goal");
	});

	it("puts the older card first between equals, then by title", () => {
		const pool = rankCandidates(
			input([
				card("young", 3),
				card("old", 3, {}, { createdAt: new Date("2026-10-01T12:00:00Z") }),
				card("b", 3, {}, { title: "B", createdAt: new Date("bad") }),
				card("a", 3, {}, { title: "A", createdAt: new Date("bad") }),
			]),
		);
		expect(pool.candidates.map((candidate) => candidate.task.id)).toEqual(["old", "young", "a", "b"]);
	});

	it("does not wait on a blocker that is done, abandoned, in the sprint, itself or unknown", () => {
		const pool = rankCandidates(
			input([
				card("done", 3, {}, { status: "done" }),
				card("gone", 3, { abandoned: true }),
				card("in", 3, { sprintId: SPRINT }),
				card("x", 3, { blockedBy: ["done", "gone", "in", "x", "nope", "spec-y", "spec-y"] }),
				card("y", 3),
			]),
		);
		const x = pool.candidates.find((candidate) => candidate.task.id === "x");
		expect(x?.waitsOn).toEqual(["y"]);
	});
});

describe("targetPoints", () => {
	it("keeps the capacity, or eight tenths of it when careful", () => {
		expect(targetPoints(20, "balanced")).toBe(20);
		expect(targetPoints(20, "careful")).toBe(16);
		expect(targetPoints(1, "careful")).toBe(1);
	});
});

describe("reasonOf", () => {
	it("names the first reason that holds", () => {
		const pool = rankCandidates(
			input(
				[
					card("u", 1, { priority: "urgent", category: "bug_fix" } as Partial<TaskMetadata>),
					card("b", 1, { category: "bug_fix" } as Partial<TaskMetadata>),
					card("k", 1),
					card("w", 1, { blockedBy: ["k"] }),
					card("g", 1, {}, { title: "Paiement" }),
					card("h", 1, { priority: "high" }),
					card("f", 1, { priority: "medium" }),
				],
				{ goal: "paiement" },
			),
		);
		const reasons = Object.fromEntries(pool.candidates.map((candidate) => [candidate.task.id, reasonOf(candidate)]));
		expect(reasons).toEqual({ u: "urgent", b: "bug", k: "unblocks", w: "fits", g: "goal", h: "high", f: "fits" });
	});
});

describe("fill", () => {
	it("adds what a card waits on first, and stops at the room", () => {
		const pool = rankCandidates(input([card("a", 5, { blockedBy: ["b"] }), card("b", 3), card("c", 8)]));
		const filled = fill(["a", "c"], pool.candidates, 10, 4, new Map([["a", "Le cœur du sprint"]]));
		expect(filled.picks).toEqual([
			{ taskId: "b", points: 3, reason: "dependency", dependencyOf: "a" },
			{ taskId: "a", points: 5, reason: "fits", note: "Le cœur du sprint" },
		]);
		expect(filled.points).toBe(8);
		expect(filled.below).toEqual([{ taskId: "c", points: 8, total: 20 }]);
	});

	it("blocks a card whose wait leads outside the candidates, and ignores unknown ids", () => {
		const pool = rankCandidates(
			input([card("a", 3, { blockedBy: ["z"] }), card("z", 0), card("b", 2)], { capacity: 10 }),
		);
		const filled = fill(["nope", "a", "b", "b"], pool.candidates, 10, 0);
		const twice = fill(["b", "b"], pool.candidates, 1, 0);
		expect(twice.below).toEqual([{ taskId: "b", points: 2, total: 2 }]);
		expect(filled.blocked).toEqual(["a"]);
		expect(filled.picks.map((pick) => pick.taskId)).toEqual(["b"]);
	});

	it("counts unblocked cards, survives a loop of waits and lists at most three below", () => {
		const pool = rankCandidates(
			input([
				card("x", 2, { blockedBy: ["y"] }),
				card("y", 2, { blockedBy: ["x"] }),
				card("k", 2),
				card("w", 13, { blockedBy: ["k"] }),
				card("p", 13),
				card("q", 13),
				card("r", 13),
			]),
		);
		const filled = fill(["k", "x", "w", "p", "q", "r"], pool.candidates, 6, 0);
		expect(filled.picks.find((pick) => pick.taskId === "k")).toMatchObject({ reason: "unblocks", unblocks: 1 });
		expect(filled.picks.map((pick) => pick.taskId).sort()).toEqual(["k", "x", "y"]);
		expect(filled.below.map((item) => item.taskId)).toEqual(["w", "p", "q"]);
	});

	it("weighs runners-up for the line only, never picking them", () => {
		const pool = rankCandidates(input([card("a", 3), card("b", 2), card("c", 9), card("d", 0)]));
		const filled = fill(["a"], pool.candidates, 10, 0, new Map(), ["a", "b", "c", "c", "d"]);
		expect(filled.picks.map((pick) => pick.taskId)).toEqual(["a"]);
		expect(filled.below).toEqual([{ taskId: "c", points: 9, total: 12 }]);
	});

	it("skips runners-up whose wait leads outside, and stops at three", () => {
		const pool = rankCandidates(
			input([card("a", 9, { blockedBy: ["z"] }), card("z", 0), card("p", 9), card("q", 9), card("r", 9), card("s", 9)]),
		);
		const filled = fill([], pool.candidates, 1, 0, new Map(), ["a", "p", "q", "r", "s"]);
		expect(filled.below.map((item) => item.taskId)).toEqual(["p", "q", "r"]);
	});
});

describe("proposeByRules", () => {
	it("fills the room left by what the sprint holds", () => {
		const proposal = proposeByRules(
			input([card("a", 8, { priority: "urgent" }), card("b", 5), card("c", 5), card("d", 0)], { capacity: 20 }),
			6,
		);
		expect(proposal).toMatchObject({
			sprintId: SPRINT,
			capacity: 20,
			committed: 6,
			points: 13,
			unestimated: ["d"],
			blocked: [],
			mode: "rules",
			variant: "balanced",
		});
		expect(proposal.picks.map((pick) => pick.taskId)).toEqual(["a", "b"]);
		expect(proposal.below).toEqual([{ taskId: "c", points: 5, total: 24 }]);
	});

	it("proposes nothing once the sprint is full", () => {
		const proposal = proposeByRules(input([card("a", 3)], { capacity: 10, variant: "careful" }), 12);
		expect(proposal.capacity).toBe(8);
		expect(proposal.picks).toEqual([]);
		expect(proposal.below).toEqual([{ taskId: "a", points: 3, total: 15 }]);
	});
});
