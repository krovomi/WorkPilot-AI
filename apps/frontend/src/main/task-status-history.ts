/**
 * Every status a task went through, beside its spec: `status_history.json`.
 *
 * The board only ever stored the status a task is in now, so nothing could
 * say how long a card stayed in progress, when it reached review or how many
 * times it went back: no cycle time, no flow diagram, no burndown. Each change
 * is appended here as `{from, to, reason?, at, actor}`, oldest first, by the
 * one writer of a task's status in local mode, this main process
 * (`plan-file-utils.ts`, called by the state manager and the status handlers).
 * In server mode the server writes the same file in the same format
 * (`apps/backend/server/services/status_history.py`) and sends it with the
 * board's snapshot.
 *
 * The file is bounded (`MAX_ENTRIES`, the creation kept), holds no name and no
 * free text, and goes with the card: deleting the task deletes its history.
 * Writing it never fails a status change: a history that cannot be written is
 * a gap in a report, not a stuck card.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../shared/constants";
import type {
	ReviewReason,
	TaskStatus,
	TaskStatusActor,
	TaskStatusTransition,
} from "../shared/types";

/** The most entries kept: the first (the creation) and the latest others. */
export const MAX_ENTRIES = 300;

const STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
	"backlog",
	"queue",
	"in_progress",
	"ai_review",
	"human_review",
	"build_failed",
	"done",
	"pr_created",
	"error",
]);

const REASONS: ReadonlySet<string> = new Set<ReviewReason>([
	"completed",
	"errors",
	"qa_rejected",
	"qa_unverified",
	"plan_review",
	"stopped",
	"prompt_too_long",
]);

const ACTORS: ReadonlySet<string> = new Set<TaskStatusActor>([
	"agent",
	"user",
	"system",
]);

/** A server account id: opaque, bounded, never a path. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The status a task had before the change, as its plan said. */
export interface PreviousStatus {
	status: TaskStatus | null;
	reason?: ReviewReason;
}

export interface StatusChange {
	to: TaskStatus;
	reason?: ReviewReason;
	actor: TaskStatusActor;
	/** Used only when the history is still empty: what the plan said before. */
	previous?: PreviousStatus | null;
	/** Defaults to now; given by tests. */
	at?: Date;
}

export function statusHistoryPath(specDir: string): string {
	return path.join(specDir, AUTO_BUILD_PATHS.STATUS_HISTORY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A status the plan holds, or null when it is not one the board knows. */
export function asTaskStatus(value: unknown): TaskStatus | null {
	return typeof value === "string" && STATUSES.has(value)
		? (value as TaskStatus)
		: null;
}

export function asReviewReason(value: unknown): ReviewReason | undefined {
	return typeof value === "string" && REASONS.has(value)
		? (value as ReviewReason)
		: undefined;
}

function parseEntry(raw: unknown): TaskStatusTransition | null {
	if (!isRecord(raw)) return null;
	const to = asTaskStatus(raw.to);
	const from = raw.from === null ? null : asTaskStatus(raw.from);
	if (!to || (raw.from !== null && from === null)) return null;
	if (typeof raw.actor !== "string" || !ACTORS.has(raw.actor)) return null;
	if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) {
		return null;
	}
	const entry: TaskStatusTransition = {
		from,
		to,
		at: raw.at,
		actor: raw.actor as TaskStatusActor,
	};
	const reason = asReviewReason(raw.reason);
	if (reason) entry.reason = reason;
	if (typeof raw.accountId === "string" && ACCOUNT_ID.test(raw.accountId)) {
		entry.accountId = raw.accountId;
	}
	return entry;
}

/**
 * The entries of a history file's content, each checked: an entry with an
 * unknown status, actor or date is dropped, the rest kept in order.
 */
export function parseStatusHistory(raw: unknown): TaskStatusTransition[] {
	const list = isRecord(raw) ? raw.entries : undefined;
	if (!Array.isArray(list)) return [];
	const entries: TaskStatusTransition[] = [];
	for (const item of list) {
		const entry = parseEntry(item);
		if (entry) entries.push(entry);
	}
	return bound(entries);
}

/** The task's history, oldest first; empty when it has none yet. */
export function readStatusHistory(specDir: string): TaskStatusTransition[] {
	try {
		return parseStatusHistory(
			JSON.parse(readFileSync(statusHistoryPath(specDir), "utf-8")),
		);
	} catch {
		return [];
	}
}

/** Keep the creation and the latest entries. */
function bound(entries: TaskStatusTransition[]): TaskStatusTransition[] {
	if (entries.length <= MAX_ENTRIES) return entries;
	return [entries[0], ...entries.slice(entries.length - (MAX_ENTRIES - 1))];
}

/**
 * Append a change to the task's history, unless it changes nothing.
 *
 * The status it leaves is the last one recorded; while the history is empty,
 * the one the plan had before (`previous`). The same status with the same
 * reason is no change: the state manager writes a restored status again at
 * every start, and that must not look like a move.
 *
 * Returns whether an entry was written.
 */
export function recordStatusChange(
	specDir: string,
	change: StatusChange,
): boolean {
	try {
		const entries = readStatusHistory(specDir);
		const last = entries.at(-1);
		const from = last ? last.to : (change.previous?.status ?? null);
		const fromReason = last ? last.reason : change.previous?.reason;
		const reason = change.reason;
		if (from === change.to && fromReason === reason) return false;
		const entry: TaskStatusTransition = {
			from,
			to: change.to,
			at: (change.at ?? new Date()).toISOString(),
			actor: change.actor,
		};
		if (reason) entry.reason = reason;
		const target = statusHistoryPath(specDir);
		// Replaced, never written in place: a reader never sees half a file,
		// and a link left where the file goes is replaced, not followed.
		const temporary = `${target}.${process.pid}.tmp`;
		writeFileSync(
			temporary,
			JSON.stringify({ version: 1, entries: bound([...entries, entry]) }, null, 2),
			"utf-8",
		);
		renameSync(temporary, target);
		return true;
	} catch (err) {
		console.warn(
			`[task-status-history] Could not record ${change.to} in ${specDir}:`,
			err,
		);
		return false;
	}
}
