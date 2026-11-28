/**
 * A card's labels (Jira's labels): short words a person puts on a card to
 * find it again, filter by and read on the board. Metadata only, the board's
 * own: an agent's run neither reads nor changes them.
 *
 * The server keeps the same limits (`shared_board/settings.py`).
 * Design: docs/architecture/kanban-labels.md.
 */
import type { Task } from "../types/task";

/** Labels a card holds, at most. */
export const MAX_LABELS = 10;
/** Characters of one label, at most. */
export const MAX_LABEL_LENGTH = 30;

function hasControl(text: string): boolean {
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** A label as a card stores it (trimmed, inner spaces collapsed), or null when it is not one. */
export function cleanLabel(raw: unknown): string | null {
	if (typeof raw !== "string" || hasControl(raw)) return null;
	const label = raw.trim().replace(/ +/g, " ");
	return label.length > 0 && label.length <= MAX_LABEL_LENGTH ? label : null;
}

/** The labels kept from anything: valid ones, once each (whatever their case), at most MAX_LABELS. */
export function cleanLabels(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const item of raw) {
		const label = cleanLabel(item);
		if (!label || seen.has(label.toLocaleLowerCase())) continue;
		seen.add(label.toLocaleLowerCase());
		labels.push(label);
		if (labels.length === MAX_LABELS) break;
	}
	return labels;
}

/** A card's labels, read safely whatever its metadata holds. */
export function taskLabels(task: Pick<Task, "metadata">): string[] {
	return cleanLabels(task.metadata?.labels);
}

/** Every label used on the board, sorted, for the filter and the suggestions. */
export function boardLabels(tasks: readonly Pick<Task, "metadata">[]): string[] {
	const labels = new Map<string, string>();
	for (const task of tasks) {
		for (const label of taskLabels(task)) {
			if (!labels.has(label.toLocaleLowerCase())) labels.set(label.toLocaleLowerCase(), label);
		}
	}
	return [...labels.values()].sort((a, b) => a.localeCompare(b));
}
