/**
 * A desktop (and ntfy / Telegram) message when the backend paused a task for
 * its cost budget (`apps/backend/cost_budget/`): the pause keeps the card in
 * its column, so without this nobody would know the task stopped until they
 * opened it. Read from the task's `pause_state.json`, written by the backend.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../shared/constants";
import type { BudgetPauseDetail } from "../shared/types/cost-budget";
import { getAppLanguage } from "./app-language";
import { notificationService } from "./notification-service";

const STRINGS = {
	en: {
		title: "Task paused: budget reached",
		stallTitle: "Task paused: no progress",
		task: '"{title}" spent {spent} USD of its {limit} USD limit. Raise it on the card to resume.',
		project: '"{title}" paused: the project spent {spent} USD of its {limit} USD budget.',
		stall: '"{title}" spent {spent} USD without completing a subtask. Read its logs, then resume it.',
	},
	fr: {
		title: "Tâche en pause : budget atteint",
		stallTitle: "Tâche en pause : aucun progrès",
		task: "« {title} » a dépensé {spent} USD sur son plafond de {limit} USD. Relevez-le sur la carte pour reprendre.",
		project: "« {title} » en pause : le projet a dépensé {spent} USD sur son budget de {limit} USD.",
		stall: "« {title} » a dépensé {spent} USD sans terminer de sous-tâche. Lisez ses journaux, puis reprenez-la.",
	},
};

interface PauseRecord {
	enabled?: boolean;
	reason?: string;
	budget?: BudgetPauseDetail;
}

/** The message for a budget pause, or null when the pause is not one. */
export function budgetPauseMessage(
	record: PauseRecord | null,
	taskTitle: string,
	language: string,
): { title: string; body: string } | null {
	if (!record?.enabled || (record.reason !== "budget" && record.reason !== "budget_stall")) return null;
	const detail = record.budget;
	if (!detail || typeof detail.spentUsd !== "number" || typeof detail.limitUsd !== "number") return null;
	const words = language.startsWith("fr") ? STRINGS.fr : STRINGS.en;
	const template = detail.scope === "stall" ? words.stall : detail.scope === "project" ? words.project : words.task;
	const body = template
		.replace("{title}", taskTitle.slice(0, 120))
		.replace("{spent}", detail.spentUsd.toFixed(2))
		.replace("{limit}", detail.limitUsd.toFixed(2));
	return { title: detail.scope === "stall" ? words.stallTitle : words.title, body };
}

/** Announce a budget pause of the task whose spec directory is `specDir`. Never throws. */
export function announceBudgetPause(projectId: string, specDir: string, taskTitle: string): void {
	let record: PauseRecord | null = null;
	try {
		record = JSON.parse(readFileSync(path.join(specDir, AUTO_BUILD_PATHS.PAUSE_STATE), "utf-8"));
	} catch {
		return;
	}
	const message = budgetPauseMessage(record, taskTitle, getAppLanguage());
	if (message) notificationService.announce(projectId, message);
}
