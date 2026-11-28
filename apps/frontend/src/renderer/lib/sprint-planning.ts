/**
 * What the sprint planning view and the board's sprint banner show: which
 * sprint the board is about, the cards a sprint can still take (the
 * backlog), the cards it holds, and the calendar days left before its end.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import type { Sprint, Task, TaskPriority } from "../../shared/types";
import { activeSprint, isTaskDone, taskPoints } from "../../shared/utils/sprints";
import { dayKey } from "./kanban-reports";
import { NO_SPRINT } from "./kanban-filter";

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const NO_PRIORITY_RANK = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The sprint the board talks about: the one its filter shows, else the
 * active one. None when the filter shows every card or the backlog and no
 * sprint is active, or when the filtered sprint no longer exists.
 */
export function focusedSprint(sprints: readonly Sprint[], filter: string | undefined): Sprint | undefined {
	if (filter && filter !== NO_SPRINT) return sprints.find((sprint) => sprint.id === filter);
	if (filter === NO_SPRINT) return undefined;
	return activeSprint(sprints);
}

/** True when a card may still be planned into a sprint: not finished, abandoned or archived. */
export function isPlannable(task: Task): boolean {
	return !isTaskDone(task) && !task.metadata?.abandoned && !task.metadata?.archivedAt;
}

function rank(task: Task): number {
	const priority = task.metadata?.priority;
	return priority ? PRIORITY_RANK[priority] : NO_PRIORITY_RANK;
}

function created(task: Task): number {
	const at = new Date(task.createdAt as unknown as string | Date).getTime();
	return Number.isNaN(at) ? 0 : at;
}

/** Most urgent first, then the oldest: the order a backlog is read in. */
export function byPlanningOrder(a: Task, b: Task): number {
	return rank(a) - rank(b) || created(a) - created(b) || a.title.localeCompare(b.title);
}

export interface PlanningPools {
	/** Cards with no sprint that can still be planned. */
	backlog: Task[];
	/** The sprint's cards, finished ones included. */
	sprint: Task[];
	/** Points of the sprint's cards. */
	points: number;
}

/** The two sides of the planning view for one sprint. */
export function planningPools(tasks: readonly Task[], sprintId: string): PlanningPools {
	const backlog: Task[] = [];
	const sprint: Task[] = [];
	let points = 0;
	for (const task of tasks) {
		const owner = task.metadata?.sprintId;
		if (owner === sprintId) {
			sprint.push(task);
			points += taskPoints(task);
		} else if (!owner && isPlannable(task)) {
			backlog.push(task);
		}
	}
	backlog.sort(byPlanningOrder);
	sprint.sort(byPlanningOrder);
	return { backlog, sprint, points };
}

/** Keeps the cards whose title (or spec id) contains the search, ignoring case and accents. */
export function matchesSearch(task: Task, search: string): boolean {
	const fold = (text: string) =>
		text
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "")
			.toLowerCase();
	const wanted = fold(search.trim());
	if (!wanted) return true;
	return fold(task.title).includes(wanted) || fold(task.specId ?? "").includes(wanted);
}

/**
 * Calendar days from today to the sprint's last day: 0 on its last day,
 * negative once it is over, null without an end day. A count of days on
 * the calendar, never an estimate of the work left.
 */
export function daysLeft(sprint: Pick<Sprint, "endDate">, now: number): number | null {
	if (!sprint.endDate) return null;
	const end = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sprint.endDate);
	const today = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey(now));
	if (!end || !today) return null;
	const endDay = Date.UTC(Number(end[1]), Number(end[2]) - 1, Number(end[3]));
	const todayDay = Date.UTC(Number(today[1]), Number(today[2]) - 1, Number(today[3]));
	return Math.round((endDay - todayDay) / DAY_MS);
}

/** The quick filters of the planning view's backlog. */
export type PlanningQuick = "all" | "urgent" | "bugs" | "unestimated";
export const PLANNING_QUICKS: readonly PlanningQuick[] = ["all", "urgent", "bugs", "unestimated"];

/** True when a card passes one of the backlog's quick filters. */
export function matchesQuick(task: Task, quick: PlanningQuick): boolean {
	switch (quick) {
		case "urgent":
			return task.metadata?.priority === "urgent" || task.metadata?.priority === "high";
		case "bugs":
			return task.metadata?.category === "bug_fix";
		case "unestimated":
			return taskPoints(task) === 0;
		default:
			return true;
	}
}

/**
 * The closed sprint that carried this unfinished card into the sprint it is
 * in now; undefined once a person moved it (the closing sprint must name
 * the card's sprint as where its unfinished cards went).
 */
export function carriedFromSprint(task: Task, sprints: readonly Sprint[]): Sprint | undefined {
	const from = task.metadata?.carriedFrom;
	const into = task.metadata?.sprintId;
	if (!from || !into) return undefined;
	return sprints.find((sprint) => sprint.id === from && sprint.state === "closed" && sprint.report?.carriedTo === into);
}

function findCard(tasks: readonly Task[], ref: string): Task | undefined {
	return tasks.find((task) => task.id === ref || task.specId === ref);
}

/**
 * The cards this one waits on (`metadata.blockedBy`) that are neither
 * finished, abandoned nor planned in the same sprint: the sprint would take
 * a card it cannot finish. A reference to a card no longer on the board
 * blocks nothing, as for the queue.
 */
export function waitingOn(task: Task, tasks: readonly Task[]): Task[] {
	const sprintId = task.metadata?.sprintId;
	const waiting: Task[] = [];
	for (const ref of task.metadata?.blockedBy ?? []) {
		const blocker = findCard(tasks, ref);
		if (!blocker || blocker.id === task.id || isTaskDone(blocker) || blocker.metadata?.abandoned) continue;
		if (sprintId && blocker.metadata?.sprintId === sprintId) continue;
		if (!waiting.includes(blocker)) waiting.push(blocker);
	}
	return waiting;
}

/** What the sprint's cards wait on that is still in the backlog: « Add these too ». */
export function missingBlockers(sprintCards: readonly Task[], tasks: readonly Task[]): Task[] {
	const missing: Task[] = [];
	for (const card of sprintCards) {
		if (isTaskDone(card)) continue;
		for (const blocker of waitingOn(card, tasks)) {
			if (!blocker.metadata?.sprintId && isPlannable(blocker) && !missing.includes(blocker)) missing.push(blocker);
		}
	}
	return missing;
}
