import { describe, expect, it } from "vitest";
import {
	DEFAULT_AGENT_PROFILES,
	DEFAULT_PHASE_MODELS,
	DEFAULT_PHASE_THINKING,
} from "../../constants/models";
import type { TaskMetadata } from "../../types";
import type {
	AppSettings,
	PhaseModelConfig,
	PhaseThinkingConfig,
} from "../../types/settings";
import {
	buildHotSwapRequest,
	buildModelMetadataUpdate,
	buildModelSelectOptions,
	buildProviderMetadataUpdate,
	buildThinkingMetadataUpdate,
	isPerPhaseThinkingTask,
	LOG_PHASE_TO_CONFIG_PHASE,
	resolvePhaseDefaults,
} from "../task-thinking";

const perPhaseMeta: TaskMetadata = {
	isAutoProfile: true,
	phaseModels: { spec: "opus", planning: "opus", coding: "opus", qa: "opus" },
	phaseThinking: {
		spec: "ultrathink",
		planning: "high",
		coding: "low",
		qa: "low",
	},
};

const singleMeta: TaskMetadata = {
	model: "opus",
	thinkingLevel: "medium",
};

describe("LOG_PHASE_TO_CONFIG_PHASE", () => {
	it("mappe planning→planning, coding→coding, validation→qa", () => {
		// « Planification » (onglet Logs) = planificateur d'implémentation
		// (config "planning"), pas la création de spec — sinon la sélection de
		// modèle n'atteint jamais le planificateur backend.
		expect(LOG_PHASE_TO_CONFIG_PHASE.planning).toBe("planning");
		expect(LOG_PHASE_TO_CONFIG_PHASE.coding).toBe("coding");
		expect(LOG_PHASE_TO_CONFIG_PHASE.validation).toBe("qa");
	});
});

describe("buildHotSwapRequest", () => {
	it("returns null when the phase is NOT actively running", () => {
		expect(
			buildHotSwapRequest("coding", "pending", { model: "claude-opus-4-8" }),
		).toBeNull();
		expect(
			buildHotSwapRequest("coding", "completed", { model: "claude-opus-4-8" }),
		).toBeNull();
		expect(
			buildHotSwapRequest("coding", undefined, { model: "claude-opus-4-8" }),
		).toBeNull();
	});

	it("returns null for an empty change even when active", () => {
		expect(buildHotSwapRequest("coding", "active", {})).toBeNull();
	});

	it("maps the log phase to the config phase and forwards the change when active", () => {
		expect(
			buildHotSwapRequest("planning", "active", { model: "claude-sonnet-4-5" }),
		).toEqual({
			configPhase: "planning",
			change: { model: "claude-sonnet-4-5" },
		});
		// validation → qa
		expect(
			buildHotSwapRequest("validation", "active", { provider: "copilot" }),
		).toEqual({ configPhase: "qa", change: { provider: "copilot" } });
		// effort-only change
		expect(buildHotSwapRequest("coding", "active", { effort: "high" })).toEqual(
			{ configPhase: "coding", change: { effort: "high" } },
		);
	});
});

describe("isPerPhaseThinkingTask", () => {
	it("détecte un profil par phase", () => {
		expect(isPerPhaseThinkingTask(perPhaseMeta)).toBe(true);
	});

	it("retourne false pour un profil mono-modèle ou metadata absente", () => {
		expect(isPerPhaseThinkingTask(singleMeta)).toBe(false);
		expect(isPerPhaseThinkingTask(undefined)).toBe(false);
	});
});

describe("resolvePhaseDefaults", () => {
	const phaseModelsCopilot: PhaseModelConfig = {
		spec: "claude-opus-4.8",
		planning: "claude-opus-4.8",
		coding: "claude-sonnet-4.6",
		qa: "claude-sonnet-4.6",
	};
	const phaseThinkingCopilot: PhaseThinkingConfig = {
		spec: "high",
		planning: "high",
		coding: "medium",
		qa: "low",
	};

	it("priorise la config par provider (providerPhaseModels[provider])", () => {
		const settings = {
			providerPhaseModels: { copilot: phaseModelsCopilot },
			providerPhaseThinking: { copilot: phaseThinkingCopilot },
		} as unknown as AppSettings;
		const defaults = resolvePhaseDefaults(settings, "copilot");
		expect(defaults.provider).toBe("copilot");
		expect(defaults.phaseModels).toEqual(phaseModelsCopilot);
		expect(defaults.phaseThinking).toEqual(phaseThinkingCopilot);
	});

	it("retombe sur customPhaseModels quand le provider n'a pas de config", () => {
		const custom: PhaseModelConfig = {
			spec: "sonnet",
			planning: "sonnet",
			coding: "sonnet",
			qa: "haiku",
		};
		const settings = {
			customPhaseModels: custom,
		} as unknown as AppSettings;
		const defaults = resolvePhaseDefaults(settings, "anthropic");
		expect(defaults.phaseModels).toEqual(custom);
	});

	it("retombe sur le profil d'agent sélectionné (auto) sans Settings", () => {
		const autoProfile = DEFAULT_AGENT_PROFILES.find((p) => p.id === "auto");
		const defaults = resolvePhaseDefaults(undefined);
		expect(defaults.provider).toBe("anthropic");
		expect(defaults.phaseModels).toEqual(autoProfile?.phaseModels);
		expect(defaults.phaseThinking).toEqual(autoProfile?.phaseThinking);
	});

	it("utilise selectedProvider quand aucun provider explicite", () => {
		const settings = { selectedProvider: "openai" } as unknown as AppSettings;
		expect(resolvePhaseDefaults(settings).provider).toBe("openai");
	});
});

describe("buildThinkingMetadataUpdate", () => {
	it("met à jour uniquement la phase ciblée pour un profil par phase", () => {
		const update = buildThinkingMetadataUpdate(perPhaseMeta, "coding", "high");
		expect(update.isAutoProfile).toBe(true);
		expect(update.phaseThinking).toEqual({
			spec: "ultrathink",
			planning: "high",
			coding: "high",
			qa: "low",
		});
		expect(update.thinkingLevel).toBeUndefined();
	});

	it("mappe la phase de logs 'validation' vers la clé 'qa'", () => {
		const update = buildThinkingMetadataUpdate(
			perPhaseMeta,
			"validation",
			"ultrathink",
		);
		expect(update.phaseThinking?.qa).toBe("ultrathink");
		// les autres phases restent inchangées
		expect(update.phaseThinking?.coding).toBe("low");
	});

	it("mappe la phase de logs 'planning' vers la clé 'planning'", () => {
		const update = buildThinkingMetadataUpdate(
			perPhaseMeta,
			"planning",
			"none",
		);
		expect(update.phaseThinking?.planning).toBe("none");
	});

	it("bascule une tâche mono-modèle en config par phase (amorcée des défauts)", () => {
		const update = buildThinkingMetadataUpdate(singleMeta, "coding", "high");
		expect(update.isAutoProfile).toBe(true);
		expect(update.thinkingLevel).toBeUndefined();
		expect(update.phaseThinking?.coding).toBe("high");
		// Les autres phases héritent des défauts applicatifs.
		expect(update.phaseThinking?.spec).toBe(DEFAULT_PHASE_THINKING.spec);
	});

	it("amorce les phases non modifiées depuis les défauts fournis", () => {
		const defaults = {
			provider: "copilot",
			phaseModels: DEFAULT_PHASE_MODELS,
			phaseThinking: {
				spec: "high",
				planning: "high",
				coding: "medium",
				qa: "low",
			} as PhaseThinkingConfig,
		};
		const update = buildThinkingMetadataUpdate(
			singleMeta,
			"validation",
			"ultrathink",
			defaults,
		);
		expect(update.phaseThinking?.qa).toBe("ultrathink");
		expect(update.phaseThinking?.coding).toBe("medium");
	});
});

describe("buildModelMetadataUpdate", () => {
	it("met à jour uniquement le modèle de la phase ciblée (profil par phase)", () => {
		const update = buildModelMetadataUpdate(perPhaseMeta, "coding", "sonnet");
		expect(update.isAutoProfile).toBe(true);
		expect(update.phaseModels).toEqual({
			spec: "opus",
			planning: "opus",
			coding: "sonnet",
			qa: "opus",
		});
		expect(update.model).toBeUndefined();
	});

	it("mappe 'validation' vers la clé 'qa'", () => {
		const update = buildModelMetadataUpdate(
			perPhaseMeta,
			"validation",
			"haiku",
		);
		expect(update.phaseModels?.qa).toBe("haiku");
		expect(update.phaseModels?.coding).toBe("opus");
	});

	it("bascule une tâche mono-modèle en config par phase (amorcée des défauts)", () => {
		const update = buildModelMetadataUpdate(singleMeta, "coding", "sonnet");
		expect(update.isAutoProfile).toBe(true);
		expect(update.model).toBeUndefined();
		expect(update.phaseModels?.coding).toBe("sonnet");
		expect(update.phaseModels?.spec).toBe(DEFAULT_PHASE_MODELS.spec);
	});
});

describe("buildProviderMetadataUpdate", () => {
	it("met à jour uniquement le provider de la phase ciblée (profil par phase)", () => {
		const update = buildProviderMetadataUpdate(
			perPhaseMeta,
			"coding",
			"copilot",
		);
		expect(update.phaseProviders).toEqual({
			spec: "anthropic",
			planning: "anthropic",
			coding: "copilot",
			qa: "anthropic",
		});
		expect(update.provider).toBeUndefined();
	});

	it("conserve les providers per-phase existants", () => {
		const meta: TaskMetadata = {
			...perPhaseMeta,
			phaseProviders: {
				spec: "anthropic",
				planning: "openai",
				coding: "anthropic",
				qa: "anthropic",
			},
		};
		const update = buildProviderMetadataUpdate(meta, "validation", "copilot");
		expect(update.phaseProviders).toEqual({
			spec: "anthropic",
			planning: "openai",
			coding: "anthropic",
			qa: "copilot",
		});
	});

	it("écrit toujours par phase pour une tâche mono-modèle (jamais le provider global)", () => {
		const update = buildProviderMetadataUpdate(singleMeta, "coding", "openai");
		expect(update.provider).toBeUndefined();
		expect(update.phaseProviders?.coding).toBe("openai");
		expect(update.phaseProviders?.spec).toBe("anthropic");
	});

	it("amorce les autres phases depuis le provider des défauts fournis", () => {
		const defaults = {
			provider: "copilot",
			phaseModels: DEFAULT_PHASE_MODELS,
			phaseThinking: DEFAULT_PHASE_THINKING,
		};
		const update = buildProviderMetadataUpdate(
			singleMeta,
			"coding",
			"openai",
			defaults,
		);
		expect(update.phaseProviders?.coding).toBe("openai");
		expect(update.phaseProviders?.spec).toBe("copilot");
	});

	it("réinitialise le modèle de la phase au défaut du nouveau provider (anti `ollama:opus`)", () => {
		// perPhaseMeta a tous ses modèles à "opus" (Anthropic). Basculer la phase
		// vers un provider local doit retirer ce modèle Claude périmé pour qu'il ne
		// puisse plus être incohérent avec le provider (le fameux `ollama:opus`).
		const localDefaults = {
			provider: "ollama",
			phaseModels: {
				spec: "llama3.1",
				planning: "llama3.1",
				coding: "llama3.1",
				qa: "llama3.1",
			},
			phaseThinking: DEFAULT_PHASE_THINKING,
		};
		const update = buildProviderMetadataUpdate(
			perPhaseMeta,
			"planning", // phase de logs « planning » → clé de config « planning »
			"ollama",
			localDefaults,
		);
		expect(update.phaseProviders?.planning).toBe("ollama");
		// La planification inclut la spec ; coding et QA restent inchanges.
		expect(update.phaseModels).toEqual({
			spec: "llama3.1",
			planning: "llama3.1",
			coding: "opus",
			qa: "opus",
		});
		expect(update.isAutoProfile).toBe(true);
	});

	it("ne réinitialise pas le modèle quand aucun défaut n'est fourni (legacy)", () => {
		const update = buildProviderMetadataUpdate(
			perPhaseMeta,
			"coding",
			"copilot",
		);
		expect(update.phaseModels).toBeUndefined();
		expect(update.isAutoProfile).toBeUndefined();
	});
});

describe("buildModelSelectOptions", () => {
	// Catalogue Anthropic déjà dédupliqué (source de vérité unique, tirets).
	const anthropicCatalog = [
		{ value: "claude-opus-4-8", label: "Claude Opus 4.8" },
		{ value: "claude-opus-4-7", label: "Claude Opus 4.7" },
		{ value: "claude-opus-4-6", label: "Claude Opus 4.6" },
		{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
	];

	it("ne crée pas de doublon quand la valeur persistée est en notation pointée", () => {
		// Reproduit le bug : modelValue = "claude-opus-4.8" (point) vs catalogue
		// "claude-opus-4-8" (tirets) → la comparaison brute injectait un 2e item.
		const { options, value } = buildModelSelectOptions(
			anthropicCatalog,
			"claude-opus-4.8",
		);
		// Aucune entrée supplémentaire : on reste sur le catalogue.
		expect(options).toHaveLength(anthropicCatalog.length);
		// Une seule entrée 4.8, avec le bon libellé (pas l'id brut).
		const opus48 = options.filter(
			(o) => o.value === "claude-opus-4-8" || o.value === "claude-opus-4.8",
		);
		expect(opus48).toHaveLength(1);
		expect(opus48[0].label).toBe("Claude Opus 4.8");
		// Le <Select> pointe sur l'entrée canonique du catalogue.
		expect(value).toBe("claude-opus-4-8");
	});

	it("aligne un alias court persisté sur l'entrée du catalogue", () => {
		const { options, value } = buildModelSelectOptions(
			anthropicCatalog,
			"opus",
		);
		expect(options).toHaveLength(anthropicCatalog.length);
		// "opus" → claude-opus-4-6 (cf. MODEL_ID_MAP), déjà présent.
		expect(value).toBe("claude-opus-4-6");
		expect(options.some((o) => o.value === "opus")).toBe(false);
	});

	it("laisse la valeur inchangée si déjà au format catalogue", () => {
		const { options, value } = buildModelSelectOptions(
			anthropicCatalog,
			"claude-opus-4-8",
		);
		expect(options).toHaveLength(anthropicCatalog.length);
		expect(value).toBe("claude-opus-4-8");
	});

	it("injecte la valeur courante absente du catalogue (filet de sécurité)", () => {
		const { options, value } = buildModelSelectOptions(
			anthropicCatalog,
			"gpt-5.5",
			{ "gpt-5.5": "GPT-5.5" },
		);
		expect(options).toHaveLength(anthropicCatalog.length + 1);
		expect(options[0]).toEqual({ value: "gpt-5.5", label: "GPT-5.5" });
		expect(value).toBe("gpt-5.5");
	});

	it("utilise l'id brut comme libellé quand aucun libellé court n'est fourni", () => {
		const { options } = buildModelSelectOptions(
			anthropicCatalog,
			"mystery-model",
		);
		expect(options[0]).toEqual({
			value: "mystery-model",
			label: "mystery-model",
		});
	});

	it("retourne une valeur vide quand aucun modèle courant", () => {
		const { options, value } = buildModelSelectOptions(anthropicCatalog, "");
		expect(value).toBe("");
		expect(options).toHaveLength(anthropicCatalog.length);
	});

	describe("fournisseur local (identité Ollama)", () => {
		// Ce que `dedupeLocalCatalog` produit : une ligne par modèle, dont la
		// `value` est le tag réellement listé par le serveur.
		const ollamaCatalog = [
			{ value: "llama3.3:latest", label: "Llama 3.3", installed: true },
			{
				value: "qwen3-embedding:8b",
				label: "qwen3-embedding:8b",
				installed: true,
			},
			{ value: "llama3.2", label: "Llama 3.2", installed: false },
		];

		it("ne dédouble pas un modèle persisté sans son tag :latest", () => {
			// Le bug : « llama3.3 » persisté vs « llama3.3:latest » installé
			// apparaissaient comme deux lignes, la sélectionnée étant marquée
			// « à télécharger » alors que le modèle était sur le disque.
			const { options, value } = buildModelSelectOptions(
				ollamaCatalog,
				"llama3.3",
				{},
				true,
			);
			expect(options).toHaveLength(ollamaCatalog.length - 1);
			expect(options.filter((o) => o.label === "Llama 3.3")).toHaveLength(1);
			expect(options.some((o) => o.value === "llama3.3")).toBe(false);
			// Le <Select> pointe sur le tag installé, donc `installed` est lisible.
			expect(value).toBe("llama3.3:latest");
			expect(options.find((o) => o.value === value)?.installed).toBe(true);
		});

		it("accepte aussi le tag complet persisté", () => {
			const { options, value } = buildModelSelectOptions(
				ollamaCatalog,
				"llama3.3:latest",
				{},
				true,
			);
			expect(options).toHaveLength(ollamaCatalog.length - 1);
			expect(value).toBe("llama3.3:latest");
		});

		it("ne collapse pas deux tags réellement différents", () => {
			// `llama3.3:70b` est un autre artefact : demander « llama3.3 » quand
			// seul `:70b` est sur le disque déclenche un pull de `:latest`.
			const { options, value } = buildModelSelectOptions(
				[{ value: "llama3.3:70b", label: "llama3.3:70b", installed: true }],
				"llama3.3",
				{},
				true,
			);
			expect(options).toHaveLength(2);
			expect(value).toBe("llama3.3");
		});

		it("garde le filet de sécurité pour un modèle hors catalogue", () => {
			const { options, value } = buildModelSelectOptions(
				ollamaCatalog,
				"deepseek-r1",
				{},
				true,
			);
			expect(options).toHaveLength(ollamaCatalog.length);
			expect(value).toBe("deepseek-r1");
		});

		it("n'applique pas l'identité Ollama à un fournisseur distant", () => {
			// Sans le drapeau, « claude-opus-4.8 » doit toujours se replier sur
			// l'entrée pointée du catalogue Anthropic.
			const { value } = buildModelSelectOptions(
				anthropicCatalog,
				"claude-opus-4.8",
			);
			expect(value).toBe("claude-opus-4-8");
		});
	});
});

it("applies a Kanban planning model to spec creation too", () => {
	const update = buildModelMetadataUpdate(perPhaseMeta, "planning", "qwen3:8b");
	expect(update.phaseModels?.spec).toBe("qwen3:8b");
	expect(update.phaseModels?.planning).toBe("qwen3:8b");
	expect(update.phaseModels?.coding).toBe("opus");
});
it("applies the planning effort to spec creation too", () => {
	expect(
		buildThinkingMetadataUpdate(perPhaseMeta, "planning", "low").phaseThinking
			?.spec,
	).toBe("low");
});
it("applies the planning provider to spec creation too", () => {
	expect(
		buildProviderMetadataUpdate(perPhaseMeta, "planning", "ollama")
			.phaseProviders?.spec,
	).toBe("ollama");
});
it("does not reinsert a persisted embedding model into agent options", () => {
	const result = buildModelSelectOptions(
		[{ value: "qwen3:8b", label: "Qwen3" }],
		"qwen3-embedding:8b",
		{},
		true,
	);
	expect(result.options.map((m) => m.value)).toEqual(["qwen3:8b"]);
	expect(result.value).toBe("");
});
