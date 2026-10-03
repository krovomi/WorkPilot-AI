import type { TaskMetadata } from "../types";
import type {
	AppSettings,
	PhaseModelConfig,
	PhaseProviderConfig,
	PhaseThinkingConfig,
	ThinkingLevel,
} from "../types/settings";
import { buildGlobalProviderMetadataUpdate } from "./task-thinking";

/**
 * Le moteur d'une tâche : Fournisseur × LLM × Effort, par phase.
 *
 * Une tâche du Kanban possède son moteur. Il est choisi à la création, modifié
 * sur la tâche elle-même (édition, pause puis reprise, changement à chaud), et
 * rien de global — le fournisseur par défaut des Paramètres, celui d'une autre
 * tâche — ne le remplace. `engineLocked` dans `task_metadata.json` est ce qui
 * le dit au backend (`phase_config.is_engine_locked`) et au main process.
 *
 * Ce module est la seule réponse à « avec quoi cette tâche tourne-t-elle ? » :
 * le renderer l'affiche, le main en tire l'environnement du sous-processus. Il
 * ne lit ni React ni Electron.
 */

export const ENGINE_PHASES = ["spec", "planning", "coding", "qa"] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

export interface EngineTrio {
	provider: string;
	model: string;
	effort: ThinkingLevel;
}

export type TaskEngine = Record<EnginePhase, EngineTrio>;

/** Settings needed to seed an engine: the default provider and its presets. */
export type EngineSeedSettings = Pick<
	AppSettings,
	| "selectedProvider"
	| "selectedAgentProfile"
	| "providerPhaseModels"
	| "providerPhaseThinking"
	| "customPhaseModels"
	| "customPhaseThinking"
	| "globalOllamaModel"
>;

export const DEFAULT_ENGINE_PROVIDER = "anthropic";

/** Anthropic and Claude are one provider spelled two ways. */
export function isClaudeProvider(provider: string | undefined | null): boolean {
	const name = (provider ?? "").trim().toLowerCase();
	return name === "anthropic" || name === "claude";
}

/** The phase a pause names (`spec`, `planning`, `coding`, `qa_review`…). */
export function enginePhaseForPause(
	pausedPhase: string | undefined | null,
): EnginePhase {
	const phase = (pausedPhase ?? "").toLowerCase();
	if (phase === "spec" || phase === "planning" || phase === "coding")
		return phase;
	if (phase.startsWith("qa") || phase === "validation") return "qa";
	return "coding";
}

/**
 * The provider a new task starts from: the project's, else the default chosen
 * in Settings, else Anthropic.
 */
export function defaultEngineProvider(
	settings: Pick<AppSettings, "selectedProvider"> | undefined,
	projectProvider?: string | null,
): string {
	return (
		projectProvider?.trim() ||
		settings?.selectedProvider?.trim() ||
		DEFAULT_ENGINE_PROVIDER
	);
}

/** Same trio on every phase. */
export function uniformEngine(trio: EngineTrio): TaskEngine {
	return {
		spec: { ...trio },
		planning: { ...trio },
		coding: { ...trio },
		qa: { ...trio },
	};
}

/**
 * The engine a task would get for `provider`, from the Settings presets
 * (`providerPhaseModels`, the agent profile, the configured local model), with
 * every model brought back into that provider's catalogue.
 */
export function seedEngine(
	settings: EngineSeedSettings | undefined,
	provider: string,
): TaskEngine {
	const seed = buildGlobalProviderMetadataUpdate(provider, settings);
	const engine = {} as TaskEngine;
	for (const phase of ENGINE_PHASES) {
		engine[phase] = {
			provider,
			model: seed.phaseModels[phase],
			effort: seed.phaseThinking[phase],
		};
	}
	return engine;
}

/**
 * What each phase of a task runs on, read the way the backend reads it.
 *
 * A locked or per-phase (`isAutoProfile`) task reads its phase models first; a
 * legacy single-model task reads `model` first. Anything missing is taken from
 * `fallback`, so the answer is always complete.
 */
export function resolveTaskEngine(
	metadata: TaskMetadata | undefined,
	fallback: TaskEngine,
): TaskEngine {
	const perPhaseModels = Boolean(
		metadata?.engineLocked || metadata?.isAutoProfile,
	);
	const engine = {} as TaskEngine;
	for (const phase of ENGINE_PHASES) {
		const phaseModel = metadata?.phaseModels?.[phase];
		const model = perPhaseModels
			? phaseModel || metadata?.model
			: metadata?.model || phaseModel;
		engine[phase] = {
			provider:
				metadata?.phaseProviders?.[phase] ||
				metadata?.provider ||
				fallback[phase].provider,
			model: model || fallback[phase].model,
			effort:
				metadata?.phaseThinking?.[phase] ||
				metadata?.thinkingLevel ||
				fallback[phase].effort,
		};
	}
	return engine;
}

export function sameTrio(a: EngineTrio, b: EngineTrio): boolean {
	return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

/** True when every phase runs the same trio. */
export function isUniformEngine(engine: TaskEngine): boolean {
	return ENGINE_PHASES.every((phase) => sameTrio(engine[phase], engine.spec));
}

/** The providers a task uses, each once, in phase order. */
export function engineProviders(engine: TaskEngine): string[] {
	return [...new Set(ENGINE_PHASES.map((phase) => engine[phase].provider))];
}

/** Whether any phase needs Claude credentials. */
export function engineUsesClaude(engine: TaskEngine): boolean {
	return engineProviders(engine).some(isClaudeProvider);
}

/**
 * The metadata that records `engine` as the task's own.
 *
 * The four phases are always written, so the backend never has to guess one.
 * The task-wide `provider`/`model`/`thinkingLevel` are the coding phase's —
 * the phase that does the work, and the one a reader without a phase asks.
 */
export function buildEngineMetadata(
	engine: TaskEngine,
): Pick<
	TaskMetadata,
	| "engineLocked"
	| "isAutoProfile"
	| "provider"
	| "model"
	| "thinkingLevel"
	| "phaseProviders"
	| "phaseModels"
	| "phaseThinking"
> {
	const phaseProviders = {} as PhaseProviderConfig;
	const phaseModels = {} as PhaseModelConfig;
	const phaseThinking = {} as PhaseThinkingConfig;
	for (const phase of ENGINE_PHASES) {
		phaseProviders[phase] = engine[phase].provider;
		phaseModels[phase] = engine[phase].model;
		phaseThinking[phase] = engine[phase].effort;
	}
	return {
		engineLocked: true,
		isAutoProfile: true,
		provider: engine.coding.provider,
		model: engine.coding.model,
		thinkingLevel: engine.coding.effort,
		phaseProviders,
		phaseModels,
		phaseThinking,
	};
}

export type EngineChangeScope = "remaining" | "phase";

/**
 * The engine after a resume with `trio`: the resumed phase and, unless
 * `scope` is `"phase"`, every phase after it. Phases already behind the task
 * keep what they ran on — that is their history, not a setting.
 */
export function applyEngineChange(
	engine: TaskEngine,
	trio: EngineTrio,
	fromPhase: EnginePhase,
	scope: EngineChangeScope,
): TaskEngine {
	const from = ENGINE_PHASES.indexOf(fromPhase);
	const next = {} as TaskEngine;
	ENGINE_PHASES.forEach((phase, index) => {
		const changed = scope === "phase" ? index === from : index >= from;
		next[phase] = changed ? { ...trio } : { ...engine[phase] };
	});
	return next;
}
