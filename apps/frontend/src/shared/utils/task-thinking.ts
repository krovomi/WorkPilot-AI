import type { TaskLogPhase, TaskMetadata } from "../types";
import { DEFAULT_PHASE_MODELS, DEFAULT_PHASE_THINKING } from "../constants/models";
import type {
	PhaseProviderConfig,
	PhaseThinkingConfig,
	ThinkingLevel,
} from "../types/settings";

/**
 * Correspondance phase de logs → clé de configuration.
 * La phase de logs « planning » couvre la création de spec ; elle pilote donc
 * le thinking de la phase `spec`.
 */
export const LOG_PHASE_TO_CONFIG_PHASE: Record<
	TaskLogPhase,
	keyof PhaseThinkingConfig
> = {
	planning: "spec",
	coding: "coding",
	validation: "qa",
};

/**
 * Vrai lorsque la tâche utilise une configuration par phase (profil Auto), où
 * chaque phase peut avoir son propre niveau de réflexion.
 */
export function isPerPhaseThinkingTask(
	metadata: TaskMetadata | undefined,
): boolean {
	return Boolean(
		metadata?.isAutoProfile && metadata.phaseModels && metadata.phaseThinking,
	);
}

/**
 * Construit la mise à jour de metadata pour changer le « thinking effort »
 * d'une phase donnée.
 *
 * - Tâche par phase (profil Auto) : on met à jour `phaseThinking[phase]` en
 *   conservant les autres phases.
 * - Tâche mono-modèle : il n'existe qu'un seul niveau partagé, on met donc à
 *   jour `thinkingLevel`.
 */
export function buildThinkingMetadataUpdate(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	level: ThinkingLevel,
): Partial<TaskMetadata> {
	if (isPerPhaseThinkingTask(metadata)) {
		const base = metadata?.phaseThinking ?? DEFAULT_PHASE_THINKING;
		const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];
		return { phaseThinking: { ...base, [configPhase]: level } };
	}
	return { thinkingLevel: level };
}

/**
 * Construit la mise à jour de metadata pour changer le modèle d'une phase.
 *
 * - Tâche par phase (profil Auto) : on met à jour `phaseModels[phase]` en
 *   conservant les autres phases.
 * - Tâche mono-modèle : on met à jour le `model` partagé.
 */
export function buildModelMetadataUpdate(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	model: string,
): Partial<TaskMetadata> {
	if (isPerPhaseThinkingTask(metadata)) {
		const base = metadata?.phaseModels ?? DEFAULT_PHASE_MODELS;
		const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];
		return { phaseModels: { ...base, [configPhase]: model } };
	}
	return { model };
}

/**
 * Construit une configuration provider par phase complète, en partant de
 * `phaseProviders` existant ou, à défaut, du provider unique de la tâche
 * (replié sur "anthropic" si absent).
 */
function basePhaseProviders(
	metadata: TaskMetadata | undefined,
): PhaseProviderConfig {
	if (metadata?.phaseProviders) return metadata.phaseProviders;
	const fallback = metadata?.provider ?? "anthropic";
	return {
		spec: fallback,
		planning: fallback,
		coding: fallback,
		qa: fallback,
	};
}

/**
 * Construit la mise à jour de metadata pour changer le fournisseur (provider)
 * d'une phase.
 *
 * - Tâche par phase (profil Auto) : on met à jour `phaseProviders[phase]` en
 *   conservant les autres phases.
 * - Tâche mono-modèle : on met à jour le `provider` partagé.
 */
export function buildProviderMetadataUpdate(
	metadata: TaskMetadata | undefined,
	logPhase: TaskLogPhase,
	provider: string,
): Partial<TaskMetadata> {
	if (isPerPhaseThinkingTask(metadata)) {
		const base = basePhaseProviders(metadata);
		const configPhase = LOG_PHASE_TO_CONFIG_PHASE[logPhase];
		return { phaseProviders: { ...base, [configPhase]: provider } };
	}
	return { provider };
}
