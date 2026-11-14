/**
 * What the Live Companion's actions turn into: a Kanban task.
 *
 * « Appliquer la correction » and « Laisser l'IA aider » used to flip a status
 * in a JSON file and touch no code. Code written into the user's project goes
 * through a worktree, a branch and a PR like any Kanban build, so both actions
 * now create a backlog task carrying what the companion saw.
 */

import type { TFunction } from "i18next";
import type {
	LiveSuggestion,
	TakeoverProposal,
} from "../../../shared/types/live-companion";

export interface CompanionTask {
	title: string;
	description: string;
}

/** A Kanban title stays one line and short enough for a card. */
const MAX_TITLE = 120;

function oneLine(text: string, max = MAX_TITLE): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `src/a/b.ts` → `b.ts`, for titles. */
function baseName(filePath: string): string {
	const parts = filePath.split(/[\\/]/);
	return parts[parts.length - 1] || filePath;
}

export function formatPause(t: TFunction, seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return minutes > 0
		? t("liveCompanion:duration.minutes", { minutes, seconds: rest })
		: t("liveCompanion:duration.seconds", { seconds: rest });
}

export function suggestionTask(
	t: TFunction,
	suggestion: LiveSuggestion,
): CompanionTask {
	const lines: string[] = [suggestion.description.trim(), ""];
	lines.push(t("liveCompanion:task.file", { file: suggestion.file_path }));
	if (suggestion.line_start > 0) {
		lines.push(
			t("liveCompanion:task.lines", {
				start: suggestion.line_start,
				end: Math.max(suggestion.line_end, suggestion.line_start),
			}),
		);
	}
	if (suggestion.related_files.length > 0) {
		lines.push(
			t("liveCompanion:task.related", {
				files: suggestion.related_files.join(", "),
			}),
		);
	}
	if (suggestion.code_fix.trim()) {
		lines.push("", t("liveCompanion:task.fix"), "```", suggestion.code_fix.trim(), "```");
	}
	lines.push(
		"",
		t("liveCompanion:task.origin", {
			type: t(`liveCompanion:suggestions.types.${suggestion.suggestion_type}`),
			priority: t(`liveCompanion:suggestions.priorities.${suggestion.priority}`),
			confidence: Math.round(suggestion.confidence * 100),
		}),
	);
	return {
		title: oneLine(
			t("liveCompanion:task.suggestionTitle", {
				title: suggestion.title,
				file: baseName(suggestion.file_path),
			}),
		),
		description: lines.join("\n").trim(),
	};
}

export function takeoverTask(
	t: TFunction,
	proposal: TakeoverProposal,
): CompanionTask {
	const count = proposal.change_count ?? 0;
	return {
		title: oneLine(
			t("liveCompanion:task.takeoverTitle", { file: baseName(proposal.file_path) }),
		),
		description: [
			t("liveCompanion:task.takeoverBody", { count }),
			"",
			t("liveCompanion:task.file", { file: proposal.file_path }),
		].join("\n"),
	};
}
