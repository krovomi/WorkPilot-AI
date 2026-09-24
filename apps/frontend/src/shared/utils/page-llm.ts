/**
 * Provider × LLM × Effort, par page.
 *
 * Une page qui lance un agent posait la question deux fois et n'en gardait
 * qu'une moitié : le modèle et l'effort venaient des réglages « par
 * fonctionnalité », et le fournisseur ne venait de nulle part — la liste
 * « Fournisseur IA » en haut à droite ne servait qu'aux builds du Kanban, si
 * bien qu'une revue de PR partait sur Claude alors que l'utilisateur avait
 * choisi Copilot une seconde plus tôt.
 *
 * Ce module est l'unique réponse à « avec quoi cette page tourne-t-elle ? ».
 * L'ordre est celui déjà établi, une source par cran :
 *
 * | Ce qui décide | Fournisseur | Modèle | Effort |
 * |---|---|---|---|
 * | 1. la page (`pageLlmOverrides[page]`) | ✔ | ✔ | ✔ |
 * | 2. les réglages (`selectedProvider`, `featureModels`, `featureThinking`) | ✔ | ✔ | ✔ |
 * | 3. les défauts du dépôt | — | ✔ | ✔ |
 *
 * Un cran vide n'en consomme pas un autre : une page qui ne nomme que le
 * fournisseur garde le modèle et l'effort des réglages, et une page qui ne
 * nomme rien se comporte exactement comme avant ce module.
 *
 * Le jeu de pages est **fermé**. Une page y entre quand son runner lit la
 * réponse — sinon le sélecteur promet un choix que rien n'applique.
 */

import {
	DEFAULT_FEATURE_MODELS,
	DEFAULT_FEATURE_THINKING,
	getModelsForProvider,
	resolveModelForProviderCatalog,
} from "../constants/models";
import type {
	AppSettings,
	FeatureModelConfig,
	ThinkingLevel,
} from "../types/settings";

/** Une fonctionnalité au sens des réglages « Modèles par fonctionnalité ». */
export type PageLlmFeature = keyof FeatureModelConfig;

/**
 * Les pages qui savent exécuter le choix, et la fonctionnalité dont elles
 * héritent quand elles ne le surchargent pas. Les clés sont des `SidebarView`.
 */
export const PAGE_LLM_FEATURES = {
	insights: "insights",
	ideation: "ideation",
	roadmap: "roadmap",
	"github-issues": "githubIssues",
	"github-prs": "githubPrs",
	"gitlab-merge-requests": "githubPrs",
	"prompt-optimizer": "promptOptimizer",
	"natural-language-git": "natural-language-git",
} as const satisfies Record<string, PageLlmFeature>;

/** Une page qui accepte une formule propre. */
export type PageLlmPage = keyof typeof PAGE_LLM_FEATURES;

/** Les pages, dans l'ordre de déclaration. */
export const PAGE_LLM_PAGES = Object.keys(PAGE_LLM_FEATURES) as PageLlmPage[];

/** Vrai si cette vue accepte une formule propre. */
export function isPageLlmPage(view: string | undefined): view is PageLlmPage {
	return !!view && view in PAGE_LLM_FEATURES;
}

/** Ce qu'une page surcharge. Un champ absent = « comme les réglages ». */
export interface PageLlmOverride {
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
}

/** D'où vient chaque cran de la réponse — ce que l'UI affiche. */
export type PageLlmSource = "page" | "settings" | "default";

export interface ResolvedPageLlm {
	page: PageLlmPage;
	feature: PageLlmFeature;
	/**
	 * Le fournisseur, ou `""` quand ni la page ni les réglages n'en nomment un :
	 * le backend garde alors sa propre valeur par défaut plutôt que de recevoir
	 * un nom inventé ici.
	 */
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	providerSource: PageLlmSource;
	modelSource: PageLlmSource;
	thinkingSource: PageLlmSource;
	/** Vrai dès qu'un cran vient de la page. */
	hasOverride: boolean;
}

/** Normalise un identifiant de fournisseur (`anthropic` et `claude` sont un). */
export function normalizeProviderId(provider: string | undefined): string {
	const value = (provider ?? "").trim().toLowerCase();
	return value === "anthropic" ? "claude" : value;
}

/** L'override enregistré pour une page, nettoyé de ses champs vides. */
export function getPageLlmOverride(
	settings: Pick<AppSettings, "pageLlmOverrides"> | undefined,
	page: PageLlmPage,
): PageLlmOverride {
	const raw = settings?.pageLlmOverrides?.[page];
	if (!raw) return {};
	const override: PageLlmOverride = {};
	if (raw.provider?.trim()) override.provider = raw.provider.trim();
	if (raw.model?.trim()) override.model = raw.model.trim();
	if (raw.thinking) override.thinking = raw.thinking;
	return override;
}

/**
 * Résout « provider × LLM × effort » pour une page.
 *
 * @param settings réglages applicatifs (partiels acceptés : un fichier
 *   `settings.json` lu tel quel convient)
 * @param page la page, telle que déclarée dans {@link PAGE_LLM_FEATURES}
 */
export function resolvePageLlm(
	settings: Partial<AppSettings> | undefined,
	page: PageLlmPage,
): ResolvedPageLlm {
	const feature = PAGE_LLM_FEATURES[page];
	const override = getPageLlmOverride(settings, page);

	// --- Fournisseur : la page, puis la liste « Fournisseur IA », puis rien.
	const globalProvider = normalizeProviderId(settings?.selectedProvider);
	const pageProvider = normalizeProviderId(override.provider);
	const provider = pageProvider || globalProvider;
	const providerSource: PageLlmSource = pageProvider
		? "page"
		: globalProvider
			? "settings"
			: "default";

	// --- Effort : la page, puis les réglages, puis le défaut du dépôt.
	const settingsThinking = settings?.featureThinking?.[feature];
	const thinking =
		override.thinking ?? settingsThinking ?? DEFAULT_FEATURE_THINKING[feature];
	const thinkingSource: PageLlmSource = override.thinking
		? "page"
		: settingsThinking
			? "settings"
			: "default";

	// --- Modèle : la page, puis les réglages, puis le défaut du dépôt.
	const settingsModel = settings?.featureModels?.[feature];
	let model =
		override.model ?? settingsModel ?? DEFAULT_FEATURE_MODELS[feature];
	let modelSource: PageLlmSource = override.model
		? "page"
		: settingsModel
			? "settings"
			: "default";

	// Inherited feature/default models must match the effective provider,
	// whether it comes from the page or the global provider selector.
	// Explicit page models remain authoritative (including custom IDs).
	if (!override.model && provider) {
		const coerced = resolveModelForProviderCatalog(
			model,
			getModelsForProvider(provider),
			provider,
		);
		if (coerced && coerced !== model) {
			model = coerced;
			modelSource = "default";
		}
	}

	return {
		page,
		feature,
		provider,
		model,
		thinking,
		providerSource,
		modelSource,
		thinkingSource,
		hasOverride: Boolean(
			override.provider || override.model || override.thinking,
		),
	};
}

/**
 * Écrit (ou efface) l'override d'une page dans une copie des réglages.
 *
 * Un champ mis à `undefined` est **retiré** plutôt que stocké vide : c'est ce
 * qui fait qu'« aucun choix » et « le même choix que les réglages » restent
 * deux états distincts, et que changer le fournisseur global bouge bien la
 * page qui n'a rien choisi.
 */
export function setPageLlmOverride(
	current: Record<string, PageLlmOverride> | undefined,
	page: PageLlmPage,
	patch: PageLlmOverride,
): Record<string, PageLlmOverride> {
	const next: Record<string, PageLlmOverride> = { ...(current ?? {}) };
	const merged: PageLlmOverride = { ...(next[page] ?? {}), ...patch };

	for (const key of ["provider", "model", "thinking"] as const) {
		if (key in patch && !patch[key]) delete merged[key];
	}

	if (!merged.provider && !merged.model && !merged.thinking) {
		delete next[page];
	} else {
		next[page] = merged;
	}
	return next;
}
