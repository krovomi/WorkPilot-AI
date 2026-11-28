/**
 * The board as a timeline (Jira's timeline): one bar per card, from when
 * work on it started to when it ended, on a window of days with the
 * sprints' dates above it. What it draws happened, or is happening: a card
 * still open runs to today, never to a guessed end.
 *
 * Rendered by `components/kanban/BoardTimeline.tsx`.
 * Design: docs/architecture/kanban-timeline.md.
 */
import type { Sprint, Task } from "../../shared/types";
import { dayKey, doneTime, startTime, time } from "./kanban-reports";

const DAY = 86_400_000;
/** Days drawn before today, at most; and after it, to see the sprints coming. */
export const TIMELINE_PAST_DAYS = 60;
export const TIMELINE_FUTURE_DAYS = 14;

export interface TimelineWindow {
	/** First millisecond and last millisecond drawn. */
	from: number;
	to: number;
}

/** From the earliest bar (60 days back at most) to two weeks after today. */
export function timelineWindow(tasks: readonly Task[], now: number): TimelineWindow {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const earliest = today.getTime() - TIMELINE_PAST_DAYS * DAY;
	const starts = tasks.map((task) => barOf(task, now).start);
	const from = Math.max(earliest, Math.min(today.getTime() - 7 * DAY, ...starts));
	const start = new Date(from);
	start.setHours(0, 0, 0, 0);
	return { from: start.getTime(), to: today.getTime() + (TIMELINE_FUTURE_DAYS + 1) * DAY - 1 };
}

export interface TimelineBar {
	start: number;
	end: number;
	/** Still running: it ends today. */
	open: boolean;
}

/** A card's bar: started (or created) until done or set aside, else until now. */
export function barOf(task: Task, now: number): TimelineBar {
	const start = startTime(task) ?? time(task.createdAt) ?? now;
	const done = task.status === "done" ? doneTime(task) : null;
	const setAside = task.metadata?.abandoned ? time(task.metadata.abandonedAt) : null;
	const end = done ?? setAside;
	return end === null ? { start, end: Math.max(start, now), open: true } : { start, end: Math.max(start, end), open: false };
}

/** Where a time falls in the window, from 0 to 100 (%), clamped to its edges. */
export function position(at: number, window: TimelineWindow): number {
	const span = window.to - window.from;
	return Math.min(100, Math.max(0, ((at - window.from) / span) * 100));
}

export interface SprintBand {
	sprint: Sprint;
	left: number;
	width: number;
}

/** The sprints with calendar dates that fall in the window, positioned. */
export function sprintBands(sprints: readonly Sprint[], window: TimelineWindow): SprintBand[] {
	const bands: SprintBand[] = [];
	for (const sprint of sprints) {
		const start = time(sprint.startDate ? `${sprint.startDate}T00:00:00` : sprint.startedAt);
		const end = time(sprint.endDate ? `${sprint.endDate}T23:59:59` : sprint.closedAt);
		if (start === null || end === null || end < start || end < window.from || start > window.to) continue;
		const left = position(start, window);
		bands.push({ sprint, left, width: Math.max(0.5, position(end, window) - left) });
	}
	return bands;
}

export interface WeekTick {
	day: string;
	left: number;
}

/** The Mondays of the window, for the axis. */
export function weekTicks(window: TimelineWindow): WeekTick[] {
	const ticks: WeekTick[] = [];
	const cursor = new Date(window.from);
	cursor.setDate(cursor.getDate() + ((8 - cursor.getDay()) % 7));
	while (cursor.getTime() <= window.to) {
		ticks.push({ day: dayKey(cursor), left: position(cursor.getTime(), window) });
		cursor.setDate(cursor.getDate() + 7);
	}
	return ticks;
}
