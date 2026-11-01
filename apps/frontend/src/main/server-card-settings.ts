/**
 * A server card's engine, priority, category and goal (server mode).
 *
 * On a local card they live in `task_metadata.json` and `.workpilot-goal.json`
 * of the spec folder. For a server card those files are the server's: the
 * app's mirror is never read by a run, so writing there changed nothing. The
 * app sends them to the server instead (`PATCH /api/board/cards/{id}/settings`,
 * `apps/backend/shared_board/settings.py`), which validates them again and
 * writes them where the build reads them.
 */

import type { IPCResult, TaskGoal, TaskGoalState, TaskMetadata } from "../shared/types";
import { authedFetch } from "./server-connection";

/** The engine fields of the metadata, as the server stores them. */
const ENGINE_KEYS = [
	"provider",
	"model",
	"thinkingLevel",
	"isAutoProfile",
	"phaseModels",
	"phaseThinking",
	"phaseProviders",
] as const;

export interface ServerCardSettings {
	engine?: Record<string, unknown> | null;
	priority?: string | null;
	category?: string | null;
	goal?: TaskGoal | null;
}

interface CardRef {
	project: { id: string };
	cardId: string;
}

function settingsUrl(card: CardRef, action = "settings"): string {
	const id = encodeURIComponent(card.cardId);
	const verb = action ? `/${action}` : "";
	return `/api/board/cards/${id}${verb}?project_id=${encodeURIComponent(card.project.id)}`;
}

/**
 * The settings a metadata change carries; `null` when it touches none. The
 * engine goes whole, as the server replaces it whole; it goes only with a
 * provider, since a card without one runs on the server's default.
 */
export function settingsFromMetadata(
	metadata: Partial<TaskMetadata> | undefined,
): ServerCardSettings | null {
	if (!metadata || typeof metadata !== "object") return null;
	const settings: ServerCardSettings = {};
	if (ENGINE_KEYS.some((key) => key in metadata)) {
		const provider = typeof metadata.provider === "string" ? metadata.provider.trim() : "";
		if (provider) {
			const engine: Record<string, unknown> = { provider };
			for (const key of ENGINE_KEYS.slice(1)) {
				const value = metadata[key];
				if (value !== undefined && value !== null && value !== "") engine[key] = value;
			}
			settings.engine = engine;
		} else {
			settings.engine = null;
		}
	}
	if ("priority" in metadata) settings.priority = metadata.priority || null;
	if ("category" in metadata) settings.category = metadata.category || null;
	return Object.keys(settings).length > 0 ? settings : null;
}

/** Send settings to the server; it answers with the card's settings as they now are. */
export async function patchServerCardSettings(
	card: CardRef,
	settings: ServerCardSettings,
): Promise<IPCResult<Record<string, unknown>>> {
	const result = await authedFetch<Record<string, unknown>>(settingsUrl(card), "PATCH", settings);
	return result.ok ? { success: true, data: result.data ?? {} } : { success: false, error: result.error };
}

function goalState(settings: unknown): TaskGoalState {
	const value = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
	if (typeof value.goalError === "string") return { goal: null, error: value.goalError };
	// The server validated the goal with the build's own rules (`goal/spec.py`).
	const goal = value.goal as TaskGoal | null | undefined;
	return { goal: goal && typeof goal.command === "string" ? goal : null };
}

/** The card's goal, as the server reads it for the build. */
export async function getServerCardGoal(card: CardRef): Promise<IPCResult<TaskGoalState>> {
	const result = await authedFetch<{ settings?: unknown }>(settingsUrl(card, ""), "GET");
	if (!result.ok) return { success: false, error: result.error };
	return { success: true, data: goalState(result.data?.settings) };
}

/** Set (or, for null, remove) the card's goal on the server. */
export async function setServerCardGoal(
	card: CardRef,
	goal: TaskGoal | null,
): Promise<IPCResult<TaskGoalState>> {
	const result = await patchServerCardSettings(card, { goal });
	if (!result.success) return { success: false, error: result.error };
	return { success: true, data: goalState(result.data) };
}
