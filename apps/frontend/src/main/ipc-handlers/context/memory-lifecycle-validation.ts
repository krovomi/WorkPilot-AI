/**
 * What the renderer may name when it acts on a memory (rule S6).
 *
 * The renderer is not trusted: every argument of the lifecycle handlers is
 * checked here before anything reaches the backend, which checks again
 * (`brain/lifecycle/store.py`, `memory_rel`). A memory is named by its vault
 * path — a note of a project's memory, in a kind folder, a `.md` file, no
 * hidden or `..` segment — never by a file-system path; the project is the
 * main process's own, looked up by id.
 */

import type { MemoryConflictChoice } from "../../../shared/types";

const FOLDERS = "(?:gotchas|patterns|codebase|outcomes|sessions)";
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const MEMORY_ID = new RegExp(
	`^knowledge/projects/[a-z0-9-]+/memory/${FOLDERS}/(?:${SEGMENT}/)*${SEGMENT}\\.md$`,
);
const TRASH_ID = new RegExp(`^${FOLDERS}/(?:${SEGMENT}/)*${SEGMENT}\\.md$`);
const CONFLICT_ID = /^[0-9a-f]{16}$/;
const CHOICES: readonly MemoryConflictChoice[] = ["a", "b", "custom", "dismiss"];

export const MAX_ID_LENGTH = 400;
export const MAX_REASON_LENGTH = 300;
export const MAX_CANONICAL_LENGTH = 4_000;

function hasDotSegment(value: string): boolean {
	return value.split("/").some((part) => part === ".." || part === ".");
}

/** A live memory's vault path, or `null`. */
export function memoryId(value: unknown): string | null {
	if (typeof value !== "string" || value.length > MAX_ID_LENGTH) return null;
	if (hasDotSegment(value) || !MEMORY_ID.test(value)) return null;
	return value;
}

/** A trash id (`gotchas/x.md`), or `null`. */
export function trashId(value: unknown): string | null {
	if (typeof value !== "string" || value.length > MAX_ID_LENGTH) return null;
	if (hasDotSegment(value) || !TRASH_ID.test(value)) return null;
	return value;
}

export function conflictId(value: unknown): string | null {
	return typeof value === "string" && CONFLICT_ID.test(value) ? value : null;
}

export function conflictChoice(value: unknown): MemoryConflictChoice | null {
	return CHOICES.find((choice) => choice === value) ?? null;
}

/** Free text a person typed: a string under its cap, or `null`. */
export function boundedText(value: unknown, max: number): string | null {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string" || value.length > max) return null;
	return value;
}
