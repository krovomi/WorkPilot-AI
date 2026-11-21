/**
 * Which provider family an office character works for, and its colours.
 *
 * A task's character wears the colour of the provider running its current
 * phase (planning, coding or QA, read as the backend reads it through
 * `resolveTaskEngine`), so a room running Claude, a local model and Copilot
 * side by side shows it at a glance. A provider nobody listed here is
 * `custom`, never mistaken for a known vendor; no provider at all keeps the
 * character's own colours.
 */

import {
	PROVIDER_FAMILIES,
	type ProviderFamily,
} from "../../shared/types/pixel-office";
import type { Task, TaskEngine } from "../../shared/types/task";
import { type EnginePhase, resolveTaskEngine } from "../../shared/utils/task-engine";

export { PROVIDER_FAMILIES, type ProviderFamily };

/** Shirt colour per family (the pixel sprite's shirt rows). */
export const FAMILY_SHIRTS: Record<ProviderFamily, string> = {
	anthropic: "#D97757",
	openai: "#10A37F",
	google: "#4285F4",
	ollama: "#ECECEC",
	copilot: "#8957E5",
	grok: "#3A3A44",
	custom: "#E5B931",
};

const FAMILY_OF: Record<string, ProviderFamily> = {
	anthropic: "anthropic",
	claude: "anthropic",
	openai: "openai",
	codex: "openai",
	"azure-openai": "openai",
	google: "google",
	gemini: "google",
	"gemini-cli": "google",
	antigravity: "google",
	ollama: "ollama",
	lmstudio: "ollama",
	local: "ollama",
	copilot: "copilot",
	"github-copilot": "copilot",
	grok: "grok",
	xai: "grok",
};

/** The family of a provider id; `custom` for an unknown one, nothing for none. */
export function providerFamilyOf(
	provider: string | null | undefined,
): ProviderFamily | undefined {
	const id = (provider ?? "").trim().toLowerCase();
	if (!id) return undefined;
	return FAMILY_OF[id] ?? "custom";
}

/** True for a value that names a family (persisted or received data). */
export function isProviderFamily(value: unknown): value is ProviderFamily {
	return (PROVIDER_FAMILIES as readonly unknown[]).includes(value);
}

const NO_PROVIDER = { provider: "", model: "", effort: "medium" } as const;
const EMPTY_ENGINE: TaskEngine = {
	spec: NO_PROVIDER,
	planning: NO_PROVIDER,
	coding: NO_PROVIDER,
	qa: NO_PROVIDER,
};

/** The engine phase a task is in, from its execution phase. */
export function enginePhaseOf(task: Task): EnginePhase {
	const phase = task.executionProgress?.phase;
	if (phase === "planning") return "planning";
	if (phase === "qa_review" || phase === "qa_fixing") return "qa";
	return "coding";
}

/** The family running one phase of a task. */
export function phaseFamily(
	task: Task,
	phase: EnginePhase,
): ProviderFamily | undefined {
	return providerFamilyOf(
		resolveTaskEngine(task.metadata, EMPTY_ENGINE)[phase].provider,
	);
}

/** The family running the phase a task is in now. */
export function taskProviderFamily(task: Task): ProviderFamily | undefined {
	return phaseFamily(task, enginePhaseOf(task));
}
