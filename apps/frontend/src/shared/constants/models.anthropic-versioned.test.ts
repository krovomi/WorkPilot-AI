import { describe, expect, it } from "vitest";
import {
	AVAILABLE_MODELS,
	isAnthropicNativeVersionedModelId,
	MODEL_ID_MAP,
	PROVIDER_MODELS_MAP,
	sortClaudeCatalog,
} from "./models";

describe("sortClaudeCatalog", () => {
	it("groupe par famille (Fable→Opus→Sonnet→Haiku) puis version décroissante", () => {
		const input = [
			"claude-sonnet-4-5",
			"claude-opus-4-6",
			"claude-haiku-4-5",
			"claude-fable-5",
			"claude-opus-4-8",
			"claude-sonnet-5",
			"claude-opus-4-20250514",
			"claude-opus-4-7",
			"claude-sonnet-4-6",
			"claude-opus-4-5",
		].map((value) => ({ value }));
		expect(sortClaudeCatalog(input).map((m) => m.value)).toEqual([
			"claude-fable-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-opus-4-5",
			"claude-opus-4-20250514", // Opus 4 (May 2025) : version 4.0, en dernier des Opus
			"claude-sonnet-5",
			"claude-sonnet-4-6",
			"claude-sonnet-4-5",
			"claude-haiku-4-5",
		]);
	});

	it("place Opus 5 au-dessus des 4.x", () => {
		const input = ["claude-opus-4-8", "claude-opus-5", "claude-opus-4-7"].map(
			(value) => ({ value }),
		);
		expect(sortClaudeCatalog(input).map((m) => m.value)).toEqual([
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
		]);
	});

	it("relègue les entrées non-Claude en fin sans planter", () => {
		const input = [{ value: "gpt-5.5" }, { value: "claude-opus-4-8" }].map(
			(m) => m,
		);
		expect(sortClaudeCatalog(input).map((m) => m.value)).toEqual([
			"claude-opus-4-8",
			"gpt-5.5",
		]);
	});
});

describe("isAnthropicNativeVersionedModelId", () => {
	it("préserve les modèles Claude en notation pointée (Copilot)", () => {
		// Régression: ces IDs sont valides pour Copilot et ne doivent PAS être
		// détectés comme des IDs Anthropic natifs (sinon le backend retombe sur le
		// modèle par défaut du fournisseur, ex. claude-sonnet-4.6).
		expect(isAnthropicNativeVersionedModelId("claude-opus-4.8")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-opus-4.7")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-sonnet-4.6")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-sonnet-4.5")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-haiku-4.5")).toBe(false);
	});

	it("détecte les IDs Anthropic natifs versionnés avec des tirets", () => {
		expect(
			isAnthropicNativeVersionedModelId("claude-sonnet-4-5-20250929"),
		).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-opus-4-5-20251101")).toBe(
			true,
		);
		expect(isAnthropicNativeVersionedModelId("claude-opus-4-6")).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-haiku-4-5-20251001")).toBe(
			true,
		);
	});

	it("détecte les IDs natifs « Mythos-class » (fable/mythos)", () => {
		// Nouvelle famille au-dessus d'Opus : un seul groupe de version (-5).
		expect(isAnthropicNativeVersionedModelId("claude-fable-5")).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-mythos-5")).toBe(true);
	});

	it("détecte la ligne principale 5-gen (claude-sonnet-5) sans casser Copilot", () => {
		// Sonnet 5 a un seul groupe de version (comme fable/mythos) et doit être
		// reconnu comme natif Anthropic…
		expect(isAnthropicNativeVersionedModelId("claude-sonnet-5")).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-opus-5")).toBe(true);
		expect(isAnthropicNativeVersionedModelId("claude-haiku-5")).toBe(true);
		// …mais la forme pointée Copilot NE doit toujours PAS matcher.
		expect(isAnthropicNativeVersionedModelId("claude-sonnet-5.0")).toBe(false);
	});

	it("ignore les modèles non-Claude", () => {
		expect(isAnthropicNativeVersionedModelId("gpt-5.5")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("gemini-3.1-pro")).toBe(false);
		expect(isAnthropicNativeVersionedModelId("claude-3.7-sonnet")).toBe(false);
	});
});

describe("catalogue Anthropic", () => {
	const catalog = PROVIDER_MODELS_MAP.anthropic;

	it("expose le flagship courant", () => {
		expect(catalog.map((m) => m.value)).toContain("claude-opus-5");
	});

	it("chaque alias court résout vers un modèle réellement au catalogue", () => {
		// Le piège que ça ferme : AVAILABLE_MODELS proposait « Claude Haiku 4.6 »,
		// une version qu'Anthropic n'a jamais publiée, sous une valeur qui
		// exécutait silencieusement la 4.5. Un libellé ne peut pas promettre un
		// modèle que le catalogue ne contient pas.
		const ids = new Set(catalog.map((m) => m.value));
		for (const { value } of AVAILABLE_MODELS) {
			const resolved = MODEL_ID_MAP[value];
			expect(resolved, `alias ${value} sans id`).toBeDefined();
			expect(
				ids.has(resolved) ||
					catalog.some((m) => m.value.startsWith(`${resolved}-`)),
				`${value} → ${resolved} absent du catalogue`,
			).toBe(true);
		}
	});

	it("ne propose aucun libellé de version inexistante", () => {
		const labels = AVAILABLE_MODELS.map((m) => m.label);
		expect(labels).not.toContain("Claude Haiku 4.6");
	});
});
