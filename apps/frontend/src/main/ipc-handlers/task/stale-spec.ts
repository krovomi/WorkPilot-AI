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
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../../../shared/constants";

/** Files the spec pipeline derives from the task description. */
export const DESCRIPTION_DERIVED_FILES: readonly string[] = [
	AUTO_BUILD_PATHS.SPEC_FILE,
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
