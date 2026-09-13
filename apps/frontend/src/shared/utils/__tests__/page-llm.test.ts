import { describe, expect, it } from "vitest";
import {
	DEFAULT_FEATURE_MODELS,
	DEFAULT_FEATURE_THINKING,
} from "../../constants/models";
import type { AppSettings } from "../../types/settings";
import {
	getPageLlmOverride,
	isPageLlmPage,
	PAGE_LLM_PAGES,
	resolvePageLlm,
	setPageLlmOverride,
} from "../page-llm";

const base = (extra: Partial<AppSettings> = {}): Partial<AppSettings> => ({
	selectedProvider: "openai",
	featureModels: { ...DEFAULT_FEATURE_MODELS, insights: "claude-sonnet-4-6" },
	featureThinking: { ...DEFAULT_FEATURE_THINKING, insights: "low" },
	...extra,
});

describe("resolvePageLlm — l'ordre établi", () => {
	it("prend le fournisseur de la page quand elle en nomme un", () => {
		const resolved = resolvePageLlm(
			base({ pageLlmOverrides: { insights: { provider: "ollama" } } }),
			"insights",
		);
		expect(resolved.provider).toBe("ollama");
		expect(resolved.providerSource).toBe("page");
	});

	it("retombe sur la liste « Fournisseur IA » quand la page ne dit rien", () => {
		const resolved = resolvePageLlm(base(), "insights");
		expect(resolved.provider).toBe("openai");
		expect(resolved.providerSource).toBe("settings");
		expect(resolved.hasOverride).toBe(false);
	});

	it("ne nomme aucun fournisseur quand personne n'en a choisi — le backend décide", () => {
		const resolved = resolvePageLlm(
			{ featureModels: DEFAULT_FEATURE_MODELS },
			"insights",
		);
		expect(resolved.provider).toBe("");
		expect(resolved.providerSource).toBe("default");
	});

	it("traite anthropic et claude comme un seul fournisseur", () => {
		const resolved = resolvePageLlm(
			{ selectedProvider: "anthropic" },
			"insights",
		);
		expect(resolved.provider).toBe("claude");
	});

	it("garde le modèle et l'effort des réglages quand seul le fournisseur est surchargé", () => {
		const resolved = resolvePageLlm(
			base({
				selectedProvider: "anthropic",
				pageLlmOverrides: { insights: { provider: "anthropic" } },
			}),
			"insights",
		);
		expect(resolved.model).toBe("claude-sonnet-4-6");
		expect(resolved.modelSource).toBe("settings");
		expect(resolved.thinking).toBe("low");
		expect(resolved.thinkingSource).toBe("settings");
	});

	it("prend le modèle et l'effort de la page quand elle les nomme", () => {
		const resolved = resolvePageLlm(
			base({
				pageLlmOverrides: {
					insights: { model: "gpt-5.2", thinking: "ultrathink" },
				},
			}),
			"insights",
		);
		expect(resolved.model).toBe("gpt-5.2");
		expect(resolved.modelSource).toBe("page");
		expect(resolved.thinking).toBe("ultrathink");
		expect(resolved.thinkingSource).toBe("page");
	});

	it("retombe sur les défauts du dépôt quand les réglages ne disent rien", () => {
		const resolved = resolvePageLlm({ selectedProvider: "anthropic" }, "roadmap");
		expect(resolved.model).toBe(DEFAULT_FEATURE_MODELS.roadmap);
		expect(resolved.modelSource).toBe("default");
		expect(resolved.thinking).toBe(DEFAULT_FEATURE_THINKING.roadmap);
		expect(resolved.thinkingSource).toBe("default");
	});

	it("ne demande pas à un fournisseur choisi sur la page un modèle qu'il n'offre pas", () => {
		// Le modèle des réglages a été choisi pour le fournisseur global.
		const resolved = resolvePageLlm(
			base({ pageLlmOverrides: { insights: { provider: "ollama" } } }),
			"insights",
		);
		expect(resolved.model).not.toBe("claude-sonnet-4-6");
		expect(resolved.modelSource).toBe("default");
	});

	it("respecte un modèle nommé par la page, même hors catalogue du fournisseur", () => {
		const resolved = resolvePageLlm(
			base({
				pageLlmOverrides: {
					insights: { provider: "ollama", model: "hf.co/org/mon-modele" },
				},
			}),
			"insights",
		);
		expect(resolved.model).toBe("hf.co/org/mon-modele");
		expect(resolved.modelSource).toBe("page");
	});

	it("répond pour chaque page déclarée", () => {
		for (const page of PAGE_LLM_PAGES) {
			const resolved = resolvePageLlm(base(), page);
			expect(resolved.page).toBe(page);
			expect(resolved.model).toBeTruthy();
			expect(resolved.thinking).toBeTruthy();
		}
	});
});

describe("isPageLlmPage", () => {
	it("reconnaît une page déclarée", () => {
		expect(isPageLlmPage("github-prs")).toBe(true);
	});

	it("refuse une vue qui ne sait pas exécuter le choix", () => {
		expect(isPageLlmPage("terminals")).toBe(false);
		expect(isPageLlmPage(undefined)).toBe(false);
	});
});

describe("getPageLlmOverride", () => {
	it("ignore les champs vides — « rien » n'est pas une valeur", () => {
		expect(
			getPageLlmOverride(
				{ pageLlmOverrides: { insights: { provider: "  ", model: "" } } },
				"insights",
			),
		).toEqual({});
	});
});

describe("setPageLlmOverride", () => {
	it("fusionne sans écraser les autres crans", () => {
		const next = setPageLlmOverride(
			{ insights: { provider: "ollama" } },
			"insights",
			{ thinking: "high" },
		);
		expect(next.insights).toEqual({ provider: "ollama", thinking: "high" });
	});

	it("retire un cran remis à « comme les réglages »", () => {
		const next = setPageLlmOverride(
			{ insights: { provider: "ollama", thinking: "high" } },
			"insights",
			{ provider: undefined },
		);
		expect(next.insights).toEqual({ thinking: "high" });
	});

	it("supprime l'entrée quand la page ne surcharge plus rien", () => {
		const next = setPageLlmOverride(
			{ insights: { provider: "ollama" }, roadmap: { thinking: "low" } },
			"insights",
			{ provider: undefined },
		);
		expect(next.insights).toBeUndefined();
		expect(next.roadmap).toEqual({ thinking: "low" });
	});

	it("ne touche pas l'objet reçu", () => {
		const current = { insights: { provider: "ollama" } };
		setPageLlmOverride(current, "roadmap", { thinking: "high" });
		expect(current).toEqual({ insights: { provider: "ollama" } });
	});
});
