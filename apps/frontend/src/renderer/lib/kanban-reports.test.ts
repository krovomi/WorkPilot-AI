/**
 * The Kanban's reports, measured from the cards' status history and the
 * sprints. Times are built in the local time zone, as the reports count days.
 */
import { describe, expect, it } from "vitest";
import type { Sprint, Task, TaskStatusTransition } from "../../shared/types";
import {
	burndown,
	cumulativeFlow,
	cycleTime,
	dayKey,
	daysBetween,
	doneTime,
	MAX_REPORT_DAYS,
	notOkEnds,
	startTime,
	throughput,
	velocityBars,
} from "./kanban-reports";

/** 12:00 on a day of November 2026, local time. */
const nov = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
const iso = (at: number) => new Date(at).toISOString();
const move = (to: TaskStatusTransition["to"], at: number): TaskStatusTransition => ({
	from: null,
	to,
	at: iso(at),
	actor: "user",
});

function card(id: string, extra: Record<string, unknown> = {}): Task {
	return {
		id,
		specId: id,
		title: id,
		status: "backlog",
		createdAt: iso(nov(1)),
		updatedAt: iso(nov(1)),
		metadata: {},
		...extra,
	} as unknown as Task;
}

const points = (score: number) => ({ smartEstimate: { complexityScore: score } }) as Task["metadata"];

describe("days", () => {
	it("names local days and counts them, both ends included, at most MAX_REPORT_DAYS", () => {
		expect(dayKey(nov(3))).toBe("2026-11-03");
		expect(daysBetween(nov(1), nov(3))).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
		expect(daysBetween(nov(1), nov(1) + 400 * 86_400_000)).toHaveLength(MAX_REPORT_DAYS);
	});
});

describe("doneTime and startTime", () => {
	it("read the history, and the last change of a card done before it", () => {
		const history = [move("backlog", nov(1)), move("in_progress", nov(2)), move("done", nov(3)), move("in_progress", nov(4)), move("done", nov(5))];
		const tracked = card("a", { status: "done", statusHistory: history });
		expect(doneTime(tracked)).toBe(nov(5));
		expect(startTime(tracked)).toBe(nov(2));
		expect(doneTime(card("b", { status: "done", updatedAt: iso(nov(6)) }))).toBe(nov(6));
		const reopened = card("r", { status: "human_review", statusHistory: [move("done", nov(3)), move("human_review", nov(4))] });
		expect(doneTime(reopened)).toBe(nov(3));
		expect(doneTime(card("c", { updatedAt: "" , status: "done" }))).toBeNull();
		expect(doneTime(card("d", { updatedAt: "not a date", status: "done" }))).toBeNull();
		expect(doneTime(card("e"))).toBeNull();
		expect(startTime(card("e"))).toBeNull();
	});
});

describe("burndown", () => {
	const sprint = (extra: Partial<Sprint>): Sprint => ({
		id: "sp-0000000a",
		name: "Sprint 12",
		state: "active",
		createdAt: "t",
		...extra,
	});
	const cards = [
		card("a", { status: "done", metadata: { ...points(5), sprintId: "sp-0000000a" }, statusHistory: [move("done", nov(3))] }),
		card("b", { status: "in_progress", metadata: { ...points(3), sprintId: "sp-0000000a" } }),
		card("c", { status: "done", metadata: { sprintId: "sp-0000000a" }, statusHistory: [move("done", nov(2))] }),
		card("other", { status: "done", metadata: points(8) }),
	];

	it("burns the points of the cards done each day, up to today", () => {
		const data = burndown(sprint({ startDate: "2026-11-02", endDate: "2026-11-06", committed: { cards: 2, points: 10 } }), cards, nov(4));
		expect(data?.days).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
		expect(data?.ideal).toEqual([10, 7.5, 5, 2.5, 0]);
		expect(data?.remaining).toEqual([8, 3, 3, null, null]);
		expect(data?.scope).toBe(8);
	});

	it("runs two weeks from the start without an end, and past the end while the sprint is open", () => {
		const open = burndown(sprint({ startedAt: iso(nov(2)) }), cards, nov(4));
		expect(open?.days).toHaveLength(14);
		expect(open?.ideal[0]).toBe(8);
		const late = burndown(sprint({ startDate: "2026-11-02", endDate: "2026-11-03" }), cards, nov(6));
		expect(late?.days.at(-1)).toBe("2026-11-06");
		const backwards = burndown(sprint({ startDate: "2026-11-05", endDate: "2026-11-01" }), cards, nov(6));
		expect(backwards?.days).toHaveLength(14);
	});

	it("needs a start", () => {
		expect(burndown(sprint({}), cards, nov(4))).toBeNull();
		expect(burndown(sprint({ startDate: "soon" }), cards, nov(4))).toBeNull();
	});
});

describe("velocityBars", () => {
	it("keeps the closed sprints with a report, oldest first, the last ones", () => {
		const closed = (id: string, closedAt: string, done: number, committed?: number): Sprint => ({
			id,
			name: id,
			state: "closed",
			createdAt: "t",
			closedAt,
			...(committed === undefined ? {} : { committed: { cards: 1, points: committed } }),
			report: { done: 1, donePoints: done, carried: 0, carriedPoints: 0, carriedTo: null },
		});
		const sprints = [
			closed("s2", "2026-11-10", 8, 10),
			closed("s1", "2026-11-03", 5),
			{ id: "s3", name: "s3", state: "active", createdAt: "t" } as Sprint,
			{ id: "s4", name: "s4", state: "closed", createdAt: "t" } as Sprint,
			closed("s0", "", 2),
		];
		expect(velocityBars(sprints)).toEqual([
			{ id: "s0", name: "s0", committed: null, done: 2 },
			{ id: "s1", name: "s1", committed: null, done: 5 },
			{ id: "s2", name: "s2", committed: 10, done: 8 },
		]);
		expect(velocityBars(sprints, 1).map((bar) => bar.id)).toEqual(["s2"]);
	});
});

describe("cumulativeFlow", () => {
	it("counts each card in its stage at the end of each day", () => {
		const flow = cumulativeFlow(
			[
				card("moved", { statusHistory: [move("backlog", nov(1)), move("in_progress", nov(2)), move("human_review", nov(3)), move("done", nov(4))] }),
				card("plain", { status: "queue", createdAt: iso(nov(3)) }),
				card("set aside", { metadata: { abandoned: true, abandonedAt: iso(nov(3)) } }),
				card("odd", { status: "archived" }),
				card("late history", { statusHistory: [move("in_progress", nov(4))] }),
				card("undated", { status: "done", createdAt: "" }),
			],
			nov(4),
			4,
		);
		expect(flow.days).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
		expect(flow.bands.todo).toEqual([2, 1, 1, 1]);
		expect(flow.bands.doing).toEqual([1, 2, 1, 2]);
		expect(flow.bands.review).toEqual([0, 0, 1, 0]);
		expect(flow.bands.done).toEqual([1, 1, 1, 2]);
	});

	it("draws 30 days by default, never more than MAX_REPORT_DAYS", () => {
		expect(cumulativeFlow([], nov(30)).days).toHaveLength(30);
		expect(cumulativeFlow([], nov(30), 500).days).toHaveLength(MAX_REPORT_DAYS);
	});
});

describe("cycleTime", () => {
	const finished = (id: string, start: number, done: number) =>
		card(id, { status: "done", statusHistory: [move("in_progress", start), move("done", done)] });

	it("measures from the first start to done, for the cards finished in the window", () => {
		const cycle = cycleTime(
			[
				finished("hours", nov(10, 9), nov(10, 15)),
				finished("two days", nov(8), nov(10)),
				finished("five days", nov(5), nov(10)),
				finished("ten days", nov(1), nov(11)),
				finished("three weeks", new Date(2026, 9, 20).getTime(), nov(11)),
				finished("long ago", new Date(2026, 5, 1).getTime(), new Date(2026, 5, 3).getTime()),
				finished("backwards", nov(12), nov(11)),
				card("never started", { status: "done", statusHistory: [move("done", nov(11))] }),
				card("not done", { statusHistory: [move("in_progress", nov(1))] }),
				card("no time", { status: "done", updatedAt: "" }),
			],
			nov(12),
		);
		expect(cycle.count).toBe(5);
		expect(cycle.bins).toEqual({ lt1: 1, d1to3: 1, d3to7: 1, d7to14: 1, gt14: 1 });
		expect(cycle.median).toBe(5);
		expect(cycle.p85).toBe(22.5);
	});

	it("has no median without a card", () => {
		expect(cycleTime([], nov(12))).toMatchObject({ count: 0, median: null, p85: null });
	});
});

describe("throughput", () => {
	it("counts the cards finished each week, Monday first, oldest week first", () => {
		const done = (id: string, at: number) => card(id, { status: "done", statusHistory: [move("done", at)] });
		const weeks = throughput(
			[done("a", nov(23)), done("b", nov(26)), done("c", nov(17)), done("old", nov(1)), card("open"), card("no time", { status: "done", updatedAt: "" })],
			nov(27),
			2,
		);
		expect(weeks).toEqual([
			{ week: "2026-11-16", count: 1 },
			{ week: "2026-11-23", count: 2 },
		]);
		expect(throughput([], nov(27))).toHaveLength(8);
	});
});

describe("notOkEnds", () => {
	it("counts the abandoned cards by resolution and the failed ones by reason", () => {
		const ends = notOkEnds([
			card("a", { metadata: { abandoned: true, abandonedResolution: "duplicate" } }),
			card("b", { metadata: { abandoned: true } }),
			card("c", { metadata: { abandoned: true, abandonedResolution: "duplicate" } }),
			card("d", { status: "human_review", reviewReason: "errors" }),
			card("e", { status: "human_review", reviewReason: "completed" }),
			card("f", { status: "done" }),
		]);
		expect(ends.abandoned).toEqual([
			{ reason: "duplicate", count: 2 },
			{ reason: "other", count: 1 },
		]);
		expect(ends.failed).toEqual([{ reason: "errors", count: 1 }]);
	});

	it("orders equal counts by name", () => {
		const ends = notOkEnds([
			card("a", { metadata: { abandoned: true, abandonedResolution: "wont_do" } }),
			card("b", { metadata: { abandoned: true, abandonedResolution: "obsolete" } }),
		]);
		expect(ends.abandoned.map((item) => item.reason)).toEqual(["obsolete", "wont_do"]);
	});
});
