import { describe, expect, it } from "vitest";
import type { TaskMetadata } from "../../types";
import { getModelsForProvider } from "../../constants/models";
import {
	applyEngineChange,
	buildEngineMetadata,
	defaultEngineProvider,
	engineProviders,
	enginePhaseForPause,
	engineUsesClaude,
	isClaudeProvider,
	isUniformEngine,
	resolveTaskEngine,
	seedEngine,
	uniformEngine,
	type TaskEngine,
} from "../task-engine";

const fallback = uniformEngine({
	provider: "anthropic",
	model: "claude-sonnet-4-6",
	effort: "medium",
});

describe("defaultEngineProvider", () => {
	it("prend le projet, puis le défaut des Paramètres, puis Anthropic", () => {
		expect(defaultEngineProvider({ selectedProvider: "openai" }, "ollama")).toBe(
			"ollama",
		);
		expect(defaultEngineProvider({ selectedProvider: "openai" }, null)).toBe(
			"openai",
		);
		expect(defaultEngineProvider(undefined)).toBe("anthropic");
	});
});

describe("seedEngine", () => {
	it("remplit les quatre phases avec des modèles du catalogue du fournisseur", () => {
		const engine = seedEngine(undefined, "openai");
		const allowed = getModelsForProvider("openai").map((m) => m.value);
		for (const trio of Object.values(engine)) {
			expect(trio.provider).toBe("openai");
			expect(allowed).toContain(trio.model);
		}
	});
});

describe("resolveTaskEngine", () => {
	it("lit les phases d'une tâche verrouillée", () => {
		const metadata: TaskMetadata = {
			engineLocked: true,
			provider: "openai",
			model: "gpt-5",
			phaseProviders: {
				spec: "openai",
				planning: "openai",
				coding: "ollama",
				qa: "anthropic",
			},
			phaseModels: {
				spec: "gpt-5",
				planning: "gpt-5",
				coding: "qwen3-coder",
				qa: "claude-opus-4-8",
			},
			phaseThinking: {
				spec: "low",
				planning: "high",
				coding: "medium",
				qa: "ultrathink",
			},
		};
		const engine = resolveTaskEngine(metadata, fallback);
		expect(engine.coding).toEqual({
			provider: "ollama",
			model: "qwen3-coder",
			effort: "medium",
		});
		expect(engine.qa.provider).toBe("anthropic");
		expect(engineProviders(engine)).toEqual(["openai", "ollama", "anthropic"]);
		expect(engineUsesClaude(engine)).toBe(true);
	});

	it("lit le modèle unique d'une ancienne tâche avant ses modèles par phase", () => {
		const engine = resolveTaskEngine(
			{
				provider: "openai",
				model: "gpt-5-mini",
				phaseModels: {
					spec: "a",
					planning: "b",
					coding: "c",
					qa: "d",
				},
			},
			fallback,
		);
		expect(engine.coding.model).toBe("gpt-5-mini");
		expect(engine.coding.provider).toBe("openai");
		expect(engine.coding.effort).toBe("medium");
	});

	it("complète une tâche sans moteur depuis le repli", () => {
		expect(resolveTaskEngine(undefined, fallback)).toEqual(fallback);
	});
});

describe("buildEngineMetadata", () => {
	it("écrit les quatre phases, verrouille, et prend la phase de code comme défaut", () => {
		const engine: TaskEngine = {
			...fallback,
			coding: { provider: "copilot", model: "gpt-5", effort: "high" },
		};
		const meta = buildEngineMetadata(engine);
		expect(meta.engineLocked).toBe(true);
		expect(meta.provider).toBe("copilot");
		expect(meta.model).toBe("gpt-5");
		expect(meta.thinkingLevel).toBe("high");
		expect(meta.phaseProviders).toEqual({
			spec: "anthropic",
			planning: "anthropic",
			coding: "copilot",
			qa: "anthropic",
		});
		// Aller-retour : ce qu'on écrit se relit à l'identique.
		expect(resolveTaskEngine(meta, fallback)).toEqual(engine);
	});
});

describe("applyEngineChange", () => {
	const trio = { provider: "ollama", model: "qwen3", effort: "low" as const };

	it("change la phase reprise et les suivantes", () => {
		const next = applyEngineChange(fallback, trio, "coding", "remaining");
		expect(next.spec).toEqual(fallback.spec);
		expect(next.planning).toEqual(fallback.planning);
		expect(next.coding).toEqual(trio);
		expect(next.qa).toEqual(trio);
		expect(isUniformEngine(next)).toBe(false);
	});

	it("peut se limiter à la phase reprise", () => {
		const next = applyEngineChange(fallback, trio, "coding", "phase");
		expect(next.coding).toEqual(trio);
		expect(next.qa).toEqual(fallback.qa);
	});

	it("ne modifie pas le moteur reçu", () => {
		applyEngineChange(fallback, trio, "spec", "remaining");
		expect(fallback.spec.provider).toBe("anthropic");
	});
});

describe("helpers", () => {
	it("reconnaît Claude sous ses deux noms", () => {
		expect(isClaudeProvider("Anthropic")).toBe(true);
		expect(isClaudeProvider("claude")).toBe(true);
		expect(isClaudeProvider("openai")).toBe(false);
		expect(isClaudeProvider(undefined)).toBe(false);
	});

	it("ramène les phases de pause aux phases du moteur", () => {
		expect(enginePhaseForPause("spec")).toBe("spec");
		expect(enginePhaseForPause("planning")).toBe("planning");
		expect(enginePhaseForPause("qa_review")).toBe("qa");
		expect(enginePhaseForPause("qa_fixing")).toBe("qa");
		expect(enginePhaseForPause(undefined)).toBe("coding");
	});
});
