/**
 * A spec written for one description must not drive a task whose description
 * changed before it ran.
 *
 * Report of 2 November: a duplicated "Create toto.txt" task, edited to ask for
 * `tata.txt`, kept the copied spec. Only its `## Overview` was rewritten; the
 * scope, files and success criteria still named `toto.txt`. The task started
 * on that spec (spec.md present = no spec creation), the coder wrote
 * `tata.txt`, and QA, judging against the spec, had it deleted.
 *
 * Patching sections cannot work: the generated parts paraphrase the old
 * request. The spec and what was derived with it are removed instead, so the
 * next start writes them again from the new description.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../../../shared/constants";

/**
 * The description a spec was written from, recorded by the backend when the
 * spec is complete (`apps/backend/spec/source.py`).
 */
export const SPEC_SOURCE_FILE = "spec_source.json";

/** Files the spec pipeline derives from the task description. */
export const DESCRIPTION_DERIVED_FILES: readonly string[] = [
	AUTO_BUILD_PATHS.SPEC_FILE,
	SPEC_SOURCE_FILE,
	"context.json",
	"graph_hints.json",
	"complexity_assessment.json",
];

function normalize(text: string | undefined | null): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

/** True when a not-yet-started task's description really changed. */
export function specIsStale(
	status: string | undefined,
	previousDescription: string | undefined | null,
	nextDescription: string,
): boolean {
	return (
		status === "backlog" &&
		normalize(previousDescription) !== normalize(nextDescription)
	);
}

/** Remove the description-derived files of a spec directory; returns their names. */
export function discardDescriptionDerivedFiles(specDir: string): string[] {
	const removed: string[] = [];
	for (const name of DESCRIPTION_DERIVED_FILES) {
		const file = path.join(specDir, name);
		if (!existsSync(file)) continue;
		rmSync(file, { force: true });
		removed.push(name);
	}
	return removed;
}

function readTaskDescription(file: string): string | null {
	try {
		const data = JSON.parse(readFileSync(file, "utf-8"));
		const value = data?.task_description;
		return typeof value === "string" && value.trim() ? value : null;
	} catch {
		return null;
	}
}

/**
 * True when the spec was written from another description than the one in
 * `requirements.json` now. A spec with no record (older than the record) or
 * a task with no readable requirements is not called stale: regenerating a
 * spec on a guess would throw away work.
 */
export function specSourceIsStale(specDir: string): boolean {
	if (!existsSync(path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE))) return false;
	const source = readTaskDescription(path.join(specDir, SPEC_SOURCE_FILE));
	const current = readTaskDescription(
		path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS),
	);
	if (source === null || current === null) return false;
	return normalize(source) !== normalize(current);
}

/**
 * Before a start: drop a spec that no longer answers the task's description,
 * so the start writes it again. Only for a task with no planned subtask yet;
 * a plan built on the old spec is the user's to restart, never removed here.
 *
 * @returns true when the spec was discarded (spec creation is needed).
 */
export function discardSpecIfStale(
	specDir: string,
	subtaskCount: number,
): boolean {
	if (!specSourceIsStale(specDir)) return false;
	if (subtaskCount > 0) {
		console.warn(
			`[stale-spec] ${specDir}: description changed after planning; spec kept with its plan`,
		);
		return false;
	}
	const removed = discardDescriptionDerivedFiles(specDir);
	console.warn(
		`[stale-spec] ${specDir}: description changed since the spec was written; discarded ${removed.join(", ")}`,
	);
	return true;
}

/**
 * A duplicated task copies its source's spec, so it inherits the record of
 * what that spec answers: the source's record, else the source's description
 * (the copied spec was written from it). A later edit of the copy then reads
 * as stale at its next start.
 */
export function copySpecSource(sourceSpecDir: string, newSpecDir: string): void {
	const description =
		readTaskDescription(path.join(sourceSpecDir, SPEC_SOURCE_FILE)) ??
		readTaskDescription(path.join(sourceSpecDir, AUTO_BUILD_PATHS.REQUIREMENTS));
	if (
		description === null ||
		!existsSync(path.join(newSpecDir, AUTO_BUILD_PATHS.SPEC_FILE))
	) {
		return;
	}
	writeFileSync(
		path.join(newSpecDir, SPEC_SOURCE_FILE),
		JSON.stringify(
			{ task_description: description, recorded_at: new Date().toISOString() },
			null,
			2,
		),
		"utf-8",
	);
}
