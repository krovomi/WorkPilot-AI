/**
 * A desktop (and ntfy / Telegram) message when the backend paused a task by
 * itself: for its cost budget (`apps/backend/cost_budget/`), or because the
 * circuit breaker saw its agent repeat the same tool call
 * (`apps/backend/agents/tool_breaker.py`), or because the session watch saw
 * its trust score fall or a sandbox limit crossed
 * (`apps/backend/agents/safety_watch.py`). The pause keeps the card in its
 * column, so without this nobody would know the task stopped until they opened
 * it. Read from the task's `pause_state.json`, written by the backend.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../shared/constants";
import type { BudgetPauseDetail } from "../shared/types/cost-budget";
import type { AnomalyPauseDetail, SandboxPauseDetail } from "../shared/types/agent-safety";
import type { BreakerPauseDetail } from "../shared/types/task";
import { getAppLanguage } from "./app-language";
import { notificationService } from "./notification-service";

const STRINGS = {
	en: {
		title: "Task paused: budget reached",
		stallTitle: "Task paused: no progress",
		breakerTitle: "Task paused: circuit breaker",
		task: '"{title}" spent {spent} USD of its {limit} USD limit. Raise it on the card to resume.',
		project: '"{title}" paused: the project spent {spent} USD of its {limit} USD budget.',
		stall: '"{title}" spent {spent} USD without completing a subtask. Read its logs, then resume it.',
		breaker:
			'"{title}" called {tool} {repeats} times with the same arguments and the same result. Read its logs, then resume it.',
		anomalyTitle: "Task paused: unusual agent behaviour",
		anomaly: '"{title}": the agent\'s trust score fell to {score}/100. Read what it did on the card before resuming it.',
		anomalyStopped:
			'"{title}": the agent\'s trust score fell to {score}/100. The session was stopped and its files restored to the snapshot taken before it.',
		sandboxTitle: "Task paused: sandbox limit",
		sandbox: '"{title}" crossed a sandbox limit. Read the card before resuming it.',
		sandboxStopped:
			'"{title}" wrote outside the sandbox\'s rules. The session was stopped and its files restored to the snapshot taken before it.',
	},
	fr: {
		title: "Tâche en pause : budget atteint",
		stallTitle: "Tâche en pause : aucun progrès",
		breakerTitle: "Tâche en pause : coupe-circuit",
		task: "« {title} » a dépensé {spent} USD sur son plafond de {limit} USD. Relevez-le sur la carte pour reprendre.",
		project: "« {title} » en pause : le projet a dépensé {spent} USD sur son budget de {limit} USD.",
		stall: "« {title} » a dépensé {spent} USD sans terminer de sous-tâche. Lisez ses journaux, puis reprenez-la.",
		breaker:
			"« {title} » a appelé {tool} {repeats} fois avec les mêmes arguments et le même résultat. Lisez ses journaux, puis reprenez-la.",
		anomalyTitle: "Tâche en pause : comportement inhabituel",
		anomaly: "« {title} » : le score de confiance de l'agent est tombé à {score}/100. Lisez ce qu'il a fait sur la carte avant de la reprendre.",
		anomalyStopped:
			"« {title} » : le score de confiance de l'agent est tombé à {score}/100. La session a été arrêtée et ses fichiers ramenés à l'instantané pris avant elle.",
		sandboxTitle: "Tâche en pause : limite du bac à sable",
		sandbox: "« {title} » a franchi une limite du bac à sable. Lisez la carte avant de la reprendre.",
		sandboxStopped:
			"« {title} » a écrit hors des règles du bac à sable. La session a été arrêtée et ses fichiers ramenés à l'instantané pris avant elle.",
	},
};

interface PauseRecord {
	enabled?: boolean;
	reason?: string;
	budget?: BudgetPauseDetail;
	breaker?: BreakerPauseDetail;
	anomaly?: AnomalyPauseDetail;
	sandbox?: SandboxPauseDetail;
}

type Words = (typeof STRINGS)["en"];

function budgetMessage(detail: BudgetPauseDetail | undefined, title: string, words: Words) {
	if (!detail || typeof detail.spentUsd !== "number" || typeof detail.limitUsd !== "number") return null;
	const template = detail.scope === "stall" ? words.stall : detail.scope === "project" ? words.project : words.task;
	const body = template
		.replace("{title}", title)
		.replace("{spent}", detail.spentUsd.toFixed(2))
		.replace("{limit}", detail.limitUsd.toFixed(2));
	return { title: detail.scope === "stall" ? words.stallTitle : words.title, body };
}

function breakerMessage(detail: BreakerPauseDetail | undefined, title: string, words: Words) {
	if (!detail || typeof detail.tool !== "string" || typeof detail.repeats !== "number") return null;
	const body = words.breaker
		.replace("{title}", title)
		.replace("{tool}", detail.tool.slice(0, 80))
		.replace("{repeats}", String(Math.trunc(detail.repeats)));
	return { title: words.breakerTitle, body };
}

function safetyMessage(record: PauseRecord, title: string, words: Words) {
	if (record.reason === "anomaly") {
		const detail = record.anomaly;
		if (!detail || typeof detail.trustScore !== "number") return null;
		const template = detail.rolledBack ? words.anomalyStopped : words.anomaly;
		const body = template
			.replace("{title}", title)
			.replace("{score}", String(Math.round(detail.trustScore)));
		return { title: words.anomalyTitle, body };
	}
	const detail = record.sandbox;
	if (!detail || typeof detail.kind !== "string") return null;
	const body = (detail.rolledBack ? words.sandboxStopped : words.sandbox).replace("{title}", title);
	return { title: words.sandboxTitle, body };
}

/** The message for a pause the backend took itself, or null for any other pause. */
export function backendPauseMessage(
	record: PauseRecord | null,
	taskTitle: string,
	language: string,
): { title: string; body: string } | null {
	if (!record?.enabled) return null;
	const words = language.startsWith("fr") ? STRINGS.fr : STRINGS.en;
	const title = taskTitle.slice(0, 120);
	if (record.reason === "budget" || record.reason === "budget_stall") {
		return budgetMessage(record.budget, title, words);
	}
	if (record.reason === "tool_loop") return breakerMessage(record.breaker, title, words);
	if (record.reason === "anomaly" || record.reason === "sandbox") {
		return safetyMessage(record, title, words);
	}
	return null;
}

/** Announce a backend pause of the task whose spec directory is `specDir`. Never throws. */
export function announceBackendPause(projectId: string, specDir: string, taskTitle: string): void {
	let record: PauseRecord | null = null;
	try {
		record = JSON.parse(readFileSync(path.join(specDir, AUTO_BUILD_PATHS.PAUSE_STATE), "utf-8"));
	} catch {
		return;
	}
	const message = backendPauseMessage(record, taskTitle, getAppLanguage());
	if (message) notificationService.announce(projectId, message);
}
