/**
 * The rules of the Kanban's sprints, shared by the main process (which
 * stores them for a local project) and the renderer: what a valid sprint is,
 * a card's points, and what a sprint holds. The server applies the same
 * rules in `apps/backend/shared_board/sprints.py`.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import type { Sprint, SprintDraft, SprintReport, SprintState } from "../types/sprint";
import type { Task } from "../types/task";

export const SPRINT_ID_PATTERN = /^sp-[0-9a-f]{8}$/;
export const MAX_SPRINT_NAME = 80;
export const MAX_SPRINT_GOAL = 500;
export const MAX_SPRINTS = 200;
/** The most points a sprint's capacity may be set to. */
export const MAX_CAPACITY = 999;
/** The capacity offered to a team with no closed sprint yet, until it sets one. */
export const DEFAULT_TARGET_POINTS = 20;
/** Closed sprints the velocity averages. */
export const VELOCITY_SPRINTS = 3;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATES: readonly SprintState[] = ["planned", "active", "closed"];

export function isSprintId(value: unknown): value is string {
	return typeof value === "string" && SPRINT_ID_PATTERN.test(value);
}

function isControl(char: string): boolean {
	const code = char.charCodeAt(0);
	return (code < 0x20 && char !== "\n") || code === 0x7f;
}

/** One line of text, trimmed, `max` characters at most; null when it is not one. */
function cleanText(raw: unknown, max: number, multiline = false): string | null {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (text.length > max) return null;
	if ([...text].some((char) => isControl(char) || (!multiline && char === "\n"))) return null;
	return text;
}

/** A calendar day `YYYY-MM-DD` that exists, or null. */
export function cleanDay(raw: unknown): string | null {
	if (typeof raw !== "string" || !DAY_PATTERN.test(raw)) return null;
	const date = new Date(`${raw}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : null;
}

/**
 * A person's sprint edit, checked: a name, an optional goal, optional days
 * with the end not before the start. Null when it is refused.
 */
export function cleanSprintDraft(raw: unknown): SprintDraft | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const draft: SprintDraft = { name: "" };
	if (value.id !== undefined) {
		if (!isSprintId(value.id)) return null;
		draft.id = value.id;
	}
	const name = cleanText(value.name, MAX_SPRINT_NAME);
	if (!name) return null;
	draft.name = name;
	if (value.goal !== undefined && value.goal !== null && value.goal !== "") {
		const goal = cleanText(value.goal, MAX_SPRINT_GOAL, true);
		if (goal === null) return null;
		if (goal) draft.goal = goal;
	}
	for (const key of ["startDate", "endDate"] as const) {
		const day = value[key];
		if (day === undefined || day === null || day === "") continue;
		const clean = cleanDay(day);
		if (!clean) return null;
		draft[key] = clean;
	}
	if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) return null;
	if (value.capacity === null) draft.capacity = null;
	else if (value.capacity !== undefined) {
		const capacity = value.capacity;
		if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
			return null;
		}
		draft.capacity = capacity;
	}
	return draft;
}

function count(raw: unknown): number {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1_000_000 ? raw : 0;
}

/** Sprints read back from a file or the server: anything malformed is left out. */
export function readSprints(raw: unknown): Sprint[] {
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray((raw as { sprints?: unknown }).sprints)
			? (raw as { sprints: unknown[] }).sprints
			: [];
	const sprints: Sprint[] = [];
	const seen = new Set<string>();
	for (const item of list.slice(0, MAX_SPRINTS)) {
		const draft = cleanSprintDraft(item);
		const value = item as Record<string, unknown>;
		if (!draft?.id || seen.has(draft.id) || !STATES.includes(value.state as SprintState)) continue;
		if (typeof value.createdAt !== "string") continue;
		seen.add(draft.id);
		const { capacity, ...fields } = draft;
		const sprint: Sprint = {
			...fields,
			id: draft.id,
			state: value.state as SprintState,
			createdAt: value.createdAt,
		};
		if (typeof capacity === "number") sprint.capacity = capacity;
		for (const key of ["startedAt", "closedAt"] as const) {
			if (typeof value[key] === "string") sprint[key] = value[key] as string;
		}
		const committed = value.committed as Record<string, unknown> | undefined;
		if (committed && typeof committed === "object") {
			sprint.committed = { cards: count(committed.cards), points: count(committed.points) };
		}
		const report = value.report as Record<string, unknown> | undefined;
		if (report && typeof report === "object") {
			sprint.report = {
				done: count(report.done),
				donePoints: count(report.donePoints),
				carried: count(report.carried),
				carriedPoints: count(report.carriedPoints),
				carriedTo: isSprintId(report.carriedTo) ? report.carriedTo : null,
			};
		}
		sprints.push(sprint);
	}
	return sprints;
}

/** A card's points: its Smart Estimation score (the person's own when adjusted), 0 when not estimated. */
export function taskPoints(task: Pick<Task, "metadata">): number {
	const estimate = task.metadata?.smartEstimate;
	const score = estimate?.adjustedScore ?? estimate?.complexityScore;
	return typeof score === "number" && Number.isFinite(score) && score > 0 ? Math.min(13, Math.round(score)) : 0;
}

/** True once a card is finished, for a sprint's count. */
export function isTaskDone(task: Pick<Task, "status">): boolean {
	return task.status === "done";
}

export interface SprintProgress {
	cards: number;
	done: number;
	points: number;
	donePoints: number;
	/** Cards with no estimate: their points are unknown. */
	unestimated: number;
}

/** What a sprint holds now. Archived cards still count: they were part of it. */
export function sprintProgress(tasks: readonly Task[], sprintId: string): SprintProgress {
	const progress: SprintProgress = { cards: 0, done: 0, points: 0, donePoints: 0, unestimated: 0 };
	for (const task of tasks) {
		if (task.metadata?.sprintId !== sprintId) continue;
		const points = taskPoints(task);
		progress.cards++;
		progress.points += points;
		if (points === 0) progress.unestimated++;
		if (isTaskDone(task)) {
			progress.done++;
			progress.donePoints += points;
		}
	}
	return progress;
}

/** The sprint in progress, if any (one at a time). */
export function activeSprint(sprints: readonly Sprint[]): Sprint | undefined {
	return sprints.find((sprint) => sprint.state === "active");
}

/** Sprints in the order a person reads them: the active one, the planned ones by start day, then the closed ones, latest first. */
export function orderedSprints(sprints: readonly Sprint[]): Sprint[] {
	const rank: Record<SprintState, number> = { active: 0, planned: 1, closed: 2 };
	return [...sprints].sort((a, b) => {
		if (a.state !== b.state) return rank[a.state] - rank[b.state];
		if (a.state === "closed") return (b.closedAt ?? "").localeCompare(a.closedAt ?? "");
		return (a.startDate ?? a.createdAt).localeCompare(b.startDate ?? b.createdAt);
	});
}

/** The last closed sprints with a report (up to {@link VELOCITY_SPRINTS}), oldest first: what the velocity averages. */
export function velocityHistory(sprints: readonly Sprint[]): Array<Sprint & { report: SprintReport }> {
	return sprints
		.filter((sprint): sprint is Sprint & { report: SprintReport } => sprint.state === "closed" && !!sprint.report)
		.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
		.slice(0, VELOCITY_SPRINTS)
		.reverse();
}

/** Average points done by the last closed sprints (up to three), or null without any. */
export function velocity(sprints: readonly Sprint[]): number | null {
	const closed = velocityHistory(sprints);
	if (closed.length === 0) return null;
	return Math.round(closed.reduce((sum, sprint) => sum + sprint.report.donePoints, 0) / closed.length);
}

export interface SprintCapacity {
	/** The points the sprint can take. */
	points: number;
	/** Where they come from: set on the sprint, the velocity, or the first-sprint default. */
	source: "set" | "velocity" | "default";
	/** The velocity of the last sprints, null before the first one closes. */
	velocity: number | null;
}

/** How many points a sprint can take: its own capacity, else the velocity, else {@link DEFAULT_TARGET_POINTS}. */
export function sprintCapacity(sprint: Pick<Sprint, "capacity">, sprints: readonly Sprint[]): SprintCapacity {
	const speed = velocity(sprints);
	if (typeof sprint.capacity === "number" && sprint.capacity > 0) {
		return { points: sprint.capacity, source: "set", velocity: speed };
	}
	if (speed !== null && speed > 0) return { points: speed, source: "velocity", velocity: speed };
	return { points: DEFAULT_TARGET_POINTS, source: "default", velocity: speed };
}
