import type { TaskLogEntry, TaskLogPhase, TaskLogs } from "../types";

/**
 * Canonical render/run order of the log phases. The logs view renders phase
 * sections in this fixed order (planning at the top, validation at the
 * bottom) regardless of which one is currently running.
 */
export const LOG_PHASE_ORDER: readonly TaskLogPhase[] = [
	"planning",
	"coding",
	"validation",
];

/**
 * Return the phase whose status is "active" (currently running), or null.
 *
 * Why this matters for scrolling: phases render in {@link LOG_PHASE_ORDER}, so
 * the newest activity is NOT necessarily at the bottom of the document. When a
 * task regresses (e.g. validation → planning), planning becomes active again
 * but its section sits at the TOP — anchoring auto-scroll to the document end
 * would leave the viewport on the stale validation logs. The logs view uses
 * this to anchor on the active phase instead.
 */
export function getActiveLogPhase(
	phaseLogs: TaskLogs | null | undefined,
): TaskLogPhase | null {
	if (!phaseLogs) return null;
	return (
		LOG_PHASE_ORDER.find(
			(phase) => phaseLogs.phases[phase]?.status === "active",
		) ?? null
	);
}

/** Render a single persisted log entry as one plain-text line. */
function formatLogEntryLine(entry: TaskLogEntry): string {
	const content = (entry.content ?? "").trim();
	if (entry.type === "tool_start" || entry.type === "tool_end") {
		const tool = entry.tool_name ?? "outil";
		const input = (entry.tool_input ?? "").trim();
		const arrow = entry.type === "tool_start" ? "⚙️" : "✅";
		return input ? `${arrow} ${tool} ${input}` : `${arrow} ${tool}`;
	}
	return content;
}

/**
 * Flatten persisted phase logs into a flat list of text lines, in phase order
 * (planning → coding → validation). Used where a lightweight, non-grouped
 * stream is needed (e.g. the Pixel Office agent bubble) as a fallback for tasks
 * that are no longer streaming live logs into `task.logs`.
 */
export function flattenTaskLogsToLines(
	phaseLogs: TaskLogs | null | undefined,
): string[] {
	if (!phaseLogs) return [];
	const lines: string[] = [];
	for (const phase of LOG_PHASE_ORDER) {
		const entries = phaseLogs.phases[phase]?.entries ?? [];
		for (const entry of entries) {
			const line = formatLogEntryLine(entry);
			if (line) lines.push(line);
		}
	}
	return lines;
}
