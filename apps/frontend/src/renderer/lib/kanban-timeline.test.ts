/**
 * The timeline: each card's bar from its start to its end (or now), the
 * window of days, the sprints' bands and the weeks along the top.
 */
import { describe, expect, it } from "vitest";
import type { Sprint, Task, TaskStatusTransition } from "../../shared/types";
import { barOf, position, sprintBands, TIMELINE_PAST_DAYS, timelineWindow, weekTicks } from "./kanban-timeline";

const DAY = 86_400_000;
/** 12:00 on a day of November 2026, local time (the 27th is a Friday). */
const nov = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
const iso = (at: number) => new Date(at).toISOString();
const move = (to: TaskStatusTransition["to"], at: number): TaskStatusTransition => ({ from: null, to, at: iso(at), actor: "agent" });
const card = (id: string, extra: Record<string, unknown> = {}) =>
	({ id, specId: id, title: id, status: "backlog", createdAt: iso(nov(10)), updatedAt: iso(nov(10)), metadata: {}, ...extra }) as unknown as Task;
const now = nov(27);

describe("barOf", () => {
	it("runs from the start of work, or the creation, to the end, or now", () => {
		expect(barOf(card("open"), now)).toEqual({ start: nov(10), end: now, open: true });
		const done = card("done", { status: "done", statusHistory: [move("in_progress", nov(12)), move("done", nov(15))] });
		expect(barOf(done, now)).toEqual({ start: nov(12), end: nov(15), open: false });
		const aside = card("aside", { metadata: { abandoned: true, abandonedAt: iso(nov(20)) } });
		expect(barOf(aside, now)).toEqual({ start: nov(10), end: nov(20), open: false });
		expect(barOf(card("undated", { createdAt: "" }), now)).toEqual({ start: now, end: now, open: true });
		const backwards = card("backwards", { status: "done", statusHistory: [move("in_progress", nov(16)), move("done", nov(15))] });
		expect(barOf(backwards, now)).toEqual({ start: nov(16), end: nov(16), open: false });
		const future = card("future", { createdAt: iso(nov(29)) });
		expect(barOf(future, now)).toEqual({ start: nov(29), end: nov(29), open: true });
	});
});

describe("timelineWindow and position", () => {
	it("starts a week back at least, 60 days back at most, and ends two weeks after today", () => {
		const recent = timelineWindow([], now);
		expect(new Date(recent.from)).toEqual(new Date(2026, 10, 20));
		expect(new Date(recent.to + 1)).toEqual(new Date(2026, 11, 12));
		const old = timelineWindow([card("old", { createdAt: iso(nov(27) - 200 * DAY) })], now);
		expect(Math.round((new Date(2026, 10, 27).getTime() - old.from) / DAY)).toBe(TIMELINE_PAST_DAYS);
		expect(new Date(timelineWindow([card("a")], now).from)).toEqual(new Date(2026, 10, 10));
	});

	it("places a time in the window, clamped to its edges", () => {
		const range = { from: 0, to: 100 };
		expect(position(25, range)).toBe(25);
		expect(position(-5, range)).toBe(0);
		expect(position(500, range)).toBe(100);
	});
});

describe("sprintBands", () => {
	const range = timelineWindow([], now);
	const sprint = (id: string, extra: Partial<Sprint>): Sprint => ({ id, name: id, state: "planned", createdAt: "t", ...extra });

	it("draws the sprints with dates that meet the window", () => {
		const bands = sprintBands(
			[
				sprint("dated", { startDate: "2026-11-23", endDate: "2026-12-04" }),
				sprint("started", { state: "closed", startedAt: iso(nov(20)), closedAt: iso(nov(20, 13)) }),
				sprint("undated", {}),
				sprint("half", { startDate: "2026-11-23" }),
				sprint("long ago", { startDate: "2026-01-01", endDate: "2026-01-14" }),
				sprint("far ahead", { startDate: "2027-03-01", endDate: "2027-03-14" }),
				sprint("backwards", { startDate: "2026-11-25", endDate: "2026-11-24" }),
			],
			range,
		);
		expect(bands.map((band) => band.sprint.id)).toEqual(["dated", "started"]);
		expect(bands[0].left).toBeCloseTo(position(new Date(2026, 10, 23).getTime(), range));
		expect(bands[1].width).toBe(0.5);
	});
});

describe("weekTicks", () => {
	it("marks each Monday of the window", () => {
		expect(weekTicks(timelineWindow([], now)).map((tick) => tick.day)).toEqual([
			"2026-11-23",
			"2026-11-30",
			"2026-12-07",
		]);
		const monday = { from: new Date(2026, 10, 23).getTime(), to: new Date(2026, 10, 24).getTime() };
		expect(weekTicks(monday)).toEqual([{ day: "2026-11-23", left: 0 }]);
	});
});
