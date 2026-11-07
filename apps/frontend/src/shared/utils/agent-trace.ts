/**
 * The Agent Trace summary the backend writes after each coder session
 * (`apps/backend/agent_trace/summary.py`, `agent-trace-summary.json`): of the
 * lines the task adds, how many an agent wrote, with which model, how many
 * the person did, how many nothing accounts for (F3).
 *
 * The file is read from the task's spec directory, so it is checked here
 * before anything of it reaches the UI.
 */

import type { WorktreeDiffAttribution, WorktreeDiffFile } from "../types/task";

export const TRACE_SUMMARY_FILE = "agent-trace-summary.json";

export interface FileAttribution {
	added: number;
	ai: number;
	human: number;
	unknown: number;
}

export interface TraceSummary {
	files: Record<string, FileAttribution>;
	totals: FileAttribution;
	models: Record<string, number>;
}

const MAX_FILES = 5000;

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function attribution(value: unknown): FileAttribution | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	return { added: count(v.added), ai: count(v.ai), human: count(v.human), unknown: count(v.unknown) };
}

/** The summary file's text → a checked summary, or null. */
export function parseTraceSummary(text: string): TraceSummary | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const raw = data as Record<string, unknown>;
	const totals = attribution(raw.totals);
	if (!totals || !raw.files || typeof raw.files !== "object") return null;
	const files: Record<string, FileAttribution> = {};
	for (const [path, value] of Object.entries(raw.files).slice(0, MAX_FILES)) {
		const parsed = attribution(value);
		if (parsed) files[path] = parsed;
	}
	const models: Record<string, number> = {};
	if (raw.models && typeof raw.models === "object") {
		for (const [model, lines] of Object.entries(raw.models).slice(0, 20)) {
			models[model.slice(0, 250)] = count(lines);
		}
	}
	return { files, totals, models };
}

/** Each diff file with its attribution, and the task's share, when there is one. */
export function applyTraceSummary(
	files: WorktreeDiffFile[],
	summary: TraceSummary | null,
): { files: WorktreeDiffFile[]; attribution?: WorktreeDiffAttribution } {
	if (!summary || summary.totals.ai <= 0) return { files };
	return {
		files: files.map((file) => {
			const found = summary.files[file.path];
			return found && found.added > 0 ? { ...file, attribution: found } : file;
		}),
		attribution: { ...summary.totals, models: summary.models },
	};
}

/** The share of `part` in `added`, as a whole percentage. */
export function sharePercent(part: number, added: number): number {
	return added > 0 ? Math.round((100 * part) / added) : 0;
}
