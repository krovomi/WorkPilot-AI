/**
 * The one-line summary under a Kanban column's title (« Bandeau » style,
 * docs/architecture/kanban-columns.md): what the column says without opening
 * a card. Computed from the cards the column already holds, no model call.
 *
 * Each item is an i18n key under `tasks:kanban.pulse` with its values; the
 * column renders them in order, and a `warn` item reads in the warning colour.
 */
import type { TaskStatusColumn } from "../../shared/constants/task";
import { ABANDON_RESOLUTIONS, type Task } from "../../shared/types";

export interface PulseItem {
	key: string;
	values?: Record<string, string | number>;
	warn?: boolean;
}

export interface PulseContext {
	now?: Date;
}

/** Review reasons where the person has to fix something, not just read. */
const NEEDS_FIX = new Set(["errors", "qa_rejected", "prompt_too_long"]);

/** Monday 00:00, local time, of the week holding `now`. */
export function startOfWeek(now: Date): Date {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const sinceMonday = (start.getDay() + 6) % 7;
	start.setDate(start.getDate() - sinceMonday);
	return start;
}

function countIf(tasks: Task[], test: (t: Task) => boolean): number {
	return tasks.reduce((n, t) => (test(t) ? n + 1 : n), 0);
}

function priorities(tasks: Task[]): PulseItem[] {
	const items: PulseItem[] = [];
	const urgent = countIf(tasks, (t) => t.metadata?.priority === "urgent");
	const high = countIf(tasks, (t) => t.metadata?.priority === "high");
	if (urgent) items.push({ key: "urgent", values: { count: urgent }, warn: true });
	if (high) items.push({ key: "high", values: { count: high } });
	return items;
}

/** Where « En cours » cards are in the pipeline; the gauge already says the slots. */
const PHASE_ITEMS: ReadonlyArray<{ key: string; phases: string[]; warn?: boolean }> = [
	{ key: "planning", phases: ["planning"] },
	{ key: "coding", phases: ["coding"] },
	{ key: "qa", phases: ["qa_review", "qa_fixing"] },
	{ key: "paused", phases: ["rate_limit_paused", "auth_failure_paused"], warn: true },
];

function inProgress(tasks: Task[]): PulseItem[] {
	const items: PulseItem[] = [];
	for (const { key, phases, warn } of PHASE_ITEMS) {
		const count = countIf(tasks, (t) => phases.includes(t.executionProgress?.phase ?? ""));
		if (count) items.push({ key, values: { count }, ...(warn ? { warn } : {}) });
	}
	return items;
}

function review(tasks: Task[]): PulseItem[] {
	const plans = countIf(tasks, (t) => t.reviewReason === "plan_review");
	const fixes = countIf(
		tasks,
		(t) => t.status === "error" || NEEDS_FIX.has(t.reviewReason ?? ""),
	);
	const reads = tasks.length - plans - fixes;
	const items: PulseItem[] = [];
	if (plans) items.push({ key: "plansToApprove", values: { count: plans } });
	if (reads) items.push({ key: "toReview", values: { count: reads } });
	if (fixes) items.push({ key: "needsFix", values: { count: fixes }, warn: true });
	return items;
}

/** Why the runs of « Échec » failed. */
function failures(tasks: Task[]): PulseItem[] {
	const context = countIf(tasks, (t) => t.reviewReason === "prompt_too_long");
	const qa = countIf(tasks, (t) => t.reviewReason === "qa_rejected");
	const errors = tasks.length - context - qa;
	const items: PulseItem[] = [];
	if (errors) items.push({ key: "failedErrors", values: { count: errors } });
	if (qa) items.push({ key: "failedQa", values: { count: qa } });
	if (context) items.push({ key: "failedContext", values: { count: context } });
	return items;
}

/** How the tasks of « Abandonnée » were closed, by resolution. */
function resolutions(tasks: Task[]): PulseItem[] {
	return ABANDON_RESOLUTIONS.flatMap((resolution) => {
		const count = countIf(
			tasks,
			(t) => (t.metadata?.abandonedResolution ?? "other") === resolution,
		);
		return count ? [{ key: `resolution_${resolution}`, values: { count } }] : [];
	});
}

export function columnPulse(
	status: TaskStatusColumn,
	tasks: Task[],
	{ now = new Date() }: PulseContext = {},
): PulseItem[] {
	if (tasks.length === 0) return [];
	switch (status) {
		case "backlog":
			return priorities(tasks);
		case "queue":
			return [{ key: "next", values: { title: tasks[0].title } }, ...priorities(tasks)];
		case "in_progress":
			return inProgress(tasks);
		case "human_review":
			return review(tasks);
		case "failed":
			return failures(tasks);
		case "abandoned":
			return resolutions(tasks);
		case "done": {
			const since = startOfWeek(now).getTime();
			const week = countIf(tasks, (t) => new Date(t.updatedAt).getTime() >= since);
			return week ? [{ key: "doneThisWeek", values: { count: week } }] : [];
		}
		default:
			return [];
	}
}
