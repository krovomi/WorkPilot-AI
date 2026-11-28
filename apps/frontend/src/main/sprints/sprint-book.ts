/**
 * The operations on a project's sprints, as the main process applies them
 * to a local project's `.workpilot/sprints.json` (local-sprints.ts). Every
 * argument comes from the renderer and is checked here (S6); the server
 * applies the same rules to a server project (`shared_board/sprints.py`).
 *
 * One sprint is active at a time; a closed sprint no longer changes; only a
 * planned sprint is deleted (its cards go back to the backlog, which the
 * renderer writes on the cards).
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { randomBytes } from "node:crypto";
import type { Sprint, SprintCommitment, SprintReport } from "../../shared/types/sprint";
import { cleanSprintDraft, isSprintId, MAX_SPRINTS } from "../../shared/utils/sprints";

export type SprintError =
	| "invalid"
	| "not_found"
	| "closed"
	| "too_many"
	| "not_planned"
	| "another_active"
	| "not_active"
	| "bad_target";

export type SprintOutcome = { sprints: Sprint[]; sprint: Sprint } | { error: SprintError };

const MAX_COUNT = 100_000;

function count(raw: unknown): number | null {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_COUNT ? raw : null;
}

export function cleanCommitment(raw: unknown): SprintCommitment | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const cards = count(value.cards);
	const points = count(value.points);
	return cards === null || points === null ? null : { cards, points };
}

export function cleanReport(raw: unknown): SprintReport | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	const numbers = (["done", "donePoints", "carried", "carriedPoints"] as const).map((key) => count(value[key]));
	if (numbers.some((n) => n === null)) return null;
	const carriedTo = value.carriedTo ?? null;
	if (carriedTo !== null && !isSprintId(carriedTo)) return null;
	const [done, donePoints, carried, carriedPoints] = numbers as number[];
	return { done, donePoints, carried, carriedPoints, carriedTo };
}

export function newSprintId(): string {
	return `sp-${randomBytes(4).toString("hex")}`;
}

function replace(sprints: readonly Sprint[], sprint: Sprint): Sprint[] {
	return sprints.map((s) => (s.id === sprint.id ? sprint : s));
}

/** Creates a sprint (planned) or changes the name, goal and days of one not closed. */
export function saveSprint(sprints: readonly Sprint[], raw: unknown, now: string, id = newSprintId()): SprintOutcome {
	const draft = cleanSprintDraft(raw);
	if (!draft) return { error: "invalid" };
	if (!draft.id) {
		if (sprints.length >= MAX_SPRINTS) return { error: "too_many" };
		const sprint: Sprint = { ...draft, id, state: "planned", createdAt: now };
		return { sprints: [...sprints, sprint], sprint };
	}
	const current = sprints.find((s) => s.id === draft.id);
	if (!current) return { error: "not_found" };
	if (current.state === "closed") return { error: "closed" };
	const sprint: Sprint = { ...current, name: draft.name, goal: draft.goal, startDate: draft.startDate, endDate: draft.endDate };
	return { sprints: replace(sprints, sprint), sprint };
}

/** Starts a planned sprint, with what it holds at that moment; one active at a time. */
export function startSprint(sprints: readonly Sprint[], id: unknown, committed: unknown, now: string): SprintOutcome {
	const commitment = cleanCommitment(committed);
	if (!isSprintId(id) || !commitment) return { error: "invalid" };
	const current = sprints.find((s) => s.id === id);
	if (!current) return { error: "not_found" };
	if (current.state !== "planned") return { error: "not_planned" };
	if (sprints.some((s) => s.state === "active")) return { error: "another_active" };
	const sprint: Sprint = { ...current, state: "active", startedAt: now, committed: commitment };
	return { sprints: replace(sprints, sprint), sprint };
}

/** Closes the active sprint with what it did; the unfinished cards went to a planned sprint or the backlog. */
export function completeSprint(sprints: readonly Sprint[], id: unknown, report: unknown, now: string): SprintOutcome {
	const done = cleanReport(report);
	if (!isSprintId(id) || !done) return { error: "invalid" };
	const current = sprints.find((s) => s.id === id);
	if (!current) return { error: "not_found" };
	if (current.state !== "active") return { error: "not_active" };
	if (done.carriedTo !== null && sprints.find((s) => s.id === done.carriedTo)?.state !== "planned") {
		return { error: "bad_target" };
	}
	const sprint: Sprint = { ...current, state: "closed", closedAt: now, report: done };
	return { sprints: replace(sprints, sprint), sprint };
}

/** Deletes a planned sprint. */
export function deleteSprint(
	sprints: readonly Sprint[],
	id: unknown,
): { sprints: Sprint[] } | { error: SprintError } {
	if (!isSprintId(id)) return { error: "invalid" };
	const current = sprints.find((s) => s.id === id);
	if (!current) return { error: "not_found" };
	if (current.state !== "planned") return { error: "not_planned" };
	return { sprints: sprints.filter((s) => s.id !== id) };
}
