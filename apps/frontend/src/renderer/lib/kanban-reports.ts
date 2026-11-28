/**
 * The Kanban's reports (Jira's agile reports): the active sprint's burndown,
 * the sprints' velocity, the cumulative flow, the cycle time, the weekly
 * throughput and the ends that were not a success. Pure functions over the
 * cards, their status history (`task.statusHistory`, docs/architecture/
 * task-status-history.md) and the sprints; drawn by
 * `components/kanban/reports/`.
 *
 * Everything here measures what happened. Nothing estimates how long a card
 * will take: points are the Smart Estimation score, never a duration.
 *
 * Design: docs/architecture/kanban-reports.md.
 */
import type { Sprint, Task, TaskStatus } from "../../shared/types";
import { taskPoints } from "../../shared/utils/sprints";
import { getBoardColumn } from "./kanban-columns";

const DAY = 86_400_000;
/** The longest span a chart draws, in days. */
export const MAX_REPORT_DAYS = 90;

function time(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	const parsed = new Date(value as string | Date).getTime();
	return Number.isNaN(parsed) ? null : parsed;
}

/** A local calendar day `YYYY-MM-DD`. */
export function dayKey(at: number | Date): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Midnight of a local day key, or null when it is not one. */
function dayStart(key: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : null;
}

/** A local day: its key and its last millisecond. */
interface Day {
	key: string;
	end: number;
}

/** The local days from `from` to `to`, both included, at most MAX_REPORT_DAYS. */
function dayRange(from: number, to: number): Day[] {
	const days: Day[] = [];
	const cursor = new Date(from);
	cursor.setHours(0, 0, 0, 0);
	while (cursor.getTime() <= to && days.length < MAX_REPORT_DAYS) {
		const key = dayKey(cursor);
		cursor.setDate(cursor.getDate() + 1);
		days.push({ key, end: cursor.getTime() - 1 });
	}
	return days;
}

/** The keys of the local days from `from` to `to`, both included, at most MAX_REPORT_DAYS. */
export function daysBetween(from: number, to: number): string[] {
	return dayRange(from, to).map((day) => day.key);
}

/** When a card was last finished; for a card done before the history existed, its last change. */
export function doneTime(task: Task): number | null {
	const history = task.statusHistory ?? [];
	for (let index = history.length - 1; index >= 0; index--) {
		if (history[index].to === "done") return time(history[index].at);
	}
	return task.status === "done" ? time(task.updatedAt) : null;
}

/** When work on a card first started (its first move to « En cours »). */
export function startTime(task: Task): number | null {
	const entry = (task.statusHistory ?? []).find((item) => item.to === "in_progress");
	return entry ? time(entry.at) : null;
}

// ============================================
// Burndown
// ============================================

export interface Burndown {
	days: string[];
	/** From what the sprint held when it started down to zero. */
	ideal: number[];
	/** Points left at the end of each day; null for the days still to come. */
	remaining: (number | null)[];
	/** Points the sprint holds now (it may have grown since its start). */
	scope: number;
}

/** The burndown of a started sprint, from its start day to its end day (or two weeks). */
export function burndown(sprint: Sprint, tasks: readonly Task[], now: number): Burndown | null {
	const start =
		(sprint.startDate ? dayStart(sprint.startDate) : null) ?? (sprint.startedAt ? time(sprint.startedAt) : null);
	if (start === null) return null;
	const plannedEnd = sprint.endDate ? dayStart(sprint.endDate) : null;
	const end = plannedEnd !== null && plannedEnd >= start ? plannedEnd : start + 13 * DAY;
	const days = dayRange(start, Math.max(end, Math.min(now, start + (MAX_REPORT_DAYS - 1) * DAY)));
	const cards = tasks.filter((task) => task.metadata?.sprintId === sprint.id);
	const scope = cards.reduce((sum, task) => sum + taskPoints(task), 0);
	const committed = sprint.committed?.points ?? scope;
	const finished = cards.map((task) => ({ points: taskPoints(task), at: task.status === "done" ? doneTime(task) : null }));
	const today = dayKey(now);
	const last = Math.max(1, days.length - 1);
	return {
		days: days.map((day) => day.key),
		ideal: days.map((_, index) => Math.max(0, Math.round((committed * (last - index)) / last * 10) / 10)),
		remaining: days.map((day) => {
			if (day.key > today) return null;
			const until = day.end;
			const burnt = finished.reduce((sum, card) => (card.at !== null && card.at <= until ? sum + card.points : sum), 0);
			return Math.max(0, scope - burnt);
		}),
		scope,
	};
}

// ============================================
// Velocity
// ============================================

export interface VelocityBar {
	id: string;
	name: string;
	/** Points held at the start; null for a sprint started before it was kept. */
	committed: number | null;
	done: number;
}

/** The last closed sprints, oldest first: what each held and what it did. */
export function velocityBars(sprints: readonly Sprint[], limit = 8): VelocityBar[] {
	return sprints
		.filter((sprint): sprint is Sprint & { report: NonNullable<Sprint["report"]> } => sprint.state === "closed" && !!sprint.report)
		.sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)))
		.slice(-limit)
		.map((sprint) => ({
			id: sprint.id,
			name: sprint.name,
			committed: sprint.committed?.points ?? null,
			done: sprint.report.donePoints,
		}));
}

// ============================================
// Cumulative flow
// ============================================

export type FlowBand = "todo" | "doing" | "review" | "done";
export const FLOW_BANDS: readonly FlowBand[] = ["todo", "doing", "review", "done"];

const BAND_OF: Record<TaskStatus, FlowBand> = {
	backlog: "todo",
	queue: "todo",
	in_progress: "doing",
	ai_review: "review",
	human_review: "review",
	build_failed: "review",
	pr_created: "review",
	error: "review",
	done: "done",
};

export interface CumulativeFlow {
	days: string[];
	/** Cards in each band at the end of each day. */
	bands: Record<FlowBand, number[]>;
}

/**
 * The cards in each band at the end of each of the last `span` days. A card
 * is counted from its creation and leaves the chart the day it is set aside;
 * a card without history is counted in its present status.
 */
export function cumulativeFlow(tasks: readonly Task[], now: number, span = 30): CumulativeFlow {
	const days = dayRange(now - (Math.min(span, MAX_REPORT_DAYS) - 1) * DAY, now);
	const bands = Object.fromEntries(FLOW_BANDS.map((band) => [band, days.map(() => 0)])) as Record<FlowBand, number[]>;
	for (const task of tasks) {
		const created = time(task.createdAt) ?? 0;
		const abandoned = task.metadata?.abandoned ? time(task.metadata.abandonedAt) : null;
		const history = (task.statusHistory ?? [])
			.map((entry) => ({ to: entry.to, at: time(entry.at) }))
			.filter((entry): entry is { to: TaskStatus; at: number } => entry.at !== null);
		days.forEach((day, index) => {
			const until = day.end;
			if (created > until || (abandoned !== null && abandoned <= until)) return;
			let status: TaskStatus | null = history.length === 0 ? task.status : null;
			for (const entry of history) if (entry.at <= until) status = entry.to;
			if (status) bands[BAND_OF[status] ?? "doing"][index]++;
		});
	}
	return { days: days.map((day) => day.key), bands };
}

// ============================================
// Cycle time and throughput
// ============================================

export type CycleBin = "lt1" | "d1to3" | "d3to7" | "d7to14" | "gt14";
export const CYCLE_BINS: readonly CycleBin[] = ["lt1", "d1to3", "d3to7", "d7to14", "gt14"];

export interface CycleTime {
	/** Cards finished in the window whose start is known. */
	count: number;
	/** In days, one decimal; null without a card. */
	median: number | null;
	p85: number | null;
	bins: Record<CycleBin, number>;
}

function binOf(days: number): CycleBin {
	if (days < 1) return "lt1";
	if (days < 3) return "d1to3";
	if (days < 7) return "d3to7";
	if (days < 14) return "d7to14";
	return "gt14";
}

function percentile(sorted: readonly number[], share: number): number {
	const index = Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1);
	return Math.round(sorted[Math.max(0, index)] * 10) / 10;
}

/** From the first move to « En cours » to « Terminée », for the cards finished in the last `span` days. */
export function cycleTime(tasks: readonly Task[], now: number, span = MAX_REPORT_DAYS): CycleTime {
	const since = now - span * DAY;
	const bins = Object.fromEntries(CYCLE_BINS.map((bin) => [bin, 0])) as Record<CycleBin, number>;
	const durations: number[] = [];
	for (const task of tasks) {
		if (task.status !== "done") continue;
		const done = doneTime(task);
		const start = startTime(task);
		if (done === null || start === null || done < since || done < start) continue;
		const days = (done - start) / DAY;
		durations.push(days);
		bins[binOf(days)]++;
	}
	durations.sort((a, b) => a - b);
	return {
		count: durations.length,
		median: durations.length ? percentile(durations, 0.5) : null,
		p85: durations.length ? percentile(durations, 0.85) : null,
		bins,
	};
}

export interface WeekCount {
	/** The Monday that starts the week, `YYYY-MM-DD`. */
	week: string;
	count: number;
}

/** Cards finished per week, the last `weeks` weeks, oldest first. */
export function throughput(tasks: readonly Task[], now: number, weeks = 8): WeekCount[] {
	const monday = new Date(now);
	monday.setHours(0, 0, 0, 0);
	monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
	const starts = Array.from({ length: weeks }, (_, index) => {
		const start = new Date(monday);
		start.setDate(start.getDate() - 7 * (weeks - 1 - index));
		return start.getTime();
	});
	const counts = starts.map((start) => ({ week: dayKey(start), count: 0 }));
	for (const task of tasks) {
		if (task.status !== "done") continue;
		const done = doneTime(task);
		if (done === null || done < starts[0]) continue;
		let index = starts.length - 1;
		while (index > 0 && starts[index] > done) index--;
		counts[index].count++;
	}
	return counts;
}

// ============================================
// Ends that were not a success
// ============================================

export interface ReasonCount {
	reason: string;
	count: number;
}

export interface NotOkEnds {
	/** Set aside, by resolution. */
	abandoned: ReasonCount[];
	/** In « Échec », by the review's reason. */
	failed: ReasonCount[];
}

function counted(reasons: string[]): ReasonCount[] {
	const counts = new Map<string, number>();
	for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
	return [...counts.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** The cards in « Abandonnée » and « Échec » now, by why they ended there. */
export function notOkEnds(tasks: readonly Task[]): NotOkEnds {
	const abandoned: string[] = [];
	const failed: string[] = [];
	for (const task of tasks) {
		const column = getBoardColumn(task);
		if (column === "abandoned") abandoned.push(task.metadata?.abandonedResolution ?? "other");
		// « Échec » is a review that ended on one of the failure reasons (`getBoardColumn`).
		else if (column === "failed") failed.push(String(task.reviewReason));
	}
	return { abandoned: counted(abandoned), failed: counted(failed) };
}
