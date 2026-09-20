/**
 * Le lecteur, côté main, de « provider × LLM × effort par page ».
 *
 * Sept handlers portaient la même fonction `getXxxFeatureSettings()` : lire
 * `settings.json`, en tirer `featureModels[feature]` et
 * `featureThinking[feature]`, retomber sur les défauts. Aucun ne lisait le
 * fournisseur, donc aucun ne suivait la liste « Fournisseur IA ». Ce module
 * est cette lecture, une fois, et il répond aussi pour le fournisseur.
 *
 * La décision elle-même n'est pas ici : `shared/utils/page-llm.ts` la tient,
 * et le renderer l'applique au même endroit pour afficher ce que la page va
 * faire. Deux résolveurs seraient deux réponses à une question.
 */

import type { AppSettings } from "../../shared/types/settings";
import type {
	PageLlmPage,
	ResolvedPageLlm,
} from "../../shared/utils/page-llm";
import { normalizeProviderId, resolvePageLlm } from "../../shared/utils/page-llm";
import { readSettingsFile } from "../settings-utils";
import { credentialManager } from "./credential-manager";

/** La formule d'une page, lue sur le disque à l'instant de l'appel. */
export function getPageLlmConfig(page: PageLlmPage): ResolvedPageLlm {
	const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
	return resolvePageLlm(settings, page);
}

/**
 * La formule d'une page sous la forme que les runners attendent déjà
 * (`--model` / `--thinking-level`).
 */
export function getPageFeatureSettings(page: PageLlmPage): {
	model: string;
	thinkingLevel: string;
	provider: string;
} {
	const resolved = getPageLlmConfig(page);
	return {
		model: resolved.model,
		thinkingLevel: resolved.thinking,
		provider: resolved.provider,
	};
}

/**
 * Les variables d'environnement du fournisseur que cette page doit utiliser :
 * `SELECTED_LLM_PROVIDER` et la clé qui va avec.
 *
 * Vide — et non « Claude » — quand rien n'est choisi nulle part : le backend a
 * sa propre chaîne de résolution (`core.client._get_active_provider`), et
 * écrire un nom ici la court-circuiterait avec une valeur que personne n'a
 * demandée.
 */
export function getPageProviderEnv(page: PageLlmPage): Record<string, string> {
	const { provider } = getPageLlmConfig(page);
	try {
		return credentialManager.getEnvironmentVariables(provider || undefined);
	} catch {
		return {};
	}
}

/**
 * Le fournisseur global — la liste « Fournisseur IA » — et la clé qui va avec.
 *
 * C'est le plancher, pas une seconde réponse : `getPageProviderEnv` retombe
 * déjà dessus pour une page qui ne surcharge rien. Un runner lancé depuis une
 * surface qui n'est pas dans `PAGE_LLM_FEATURES` n'avait, lui, aucun
 * `SELECTED_LLM_PROVIDER` du tout — le backend repartait donc sur son propre
 * défaut, et le choix affiché en haut à droite ne voulait rien dire pour la
 * génération de tests, l'auto-fix GitHub ou l'auto-réparation. Une page sans
 * formule propre est une page qui suit les réglages ; une surface qui n'en a
 * pas non plus.
 *
 * Vide quand personne n'a rien choisi : le backend garde alors sa chaîne de
 * résolution plutôt qu'un nom inventé ici.
 */
export function getGlobalProviderEnv(): Record<string, string> {
	try {
		const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
		const provider = normalizeProviderId(settings.selectedProvider);
		// Le nom choisi est passé en surcharge, comme pour une page : c'est ce qui
		// force `SELECTED_LLM_PROVIDER` même quand le choix est Claude, que le
		// chemin sans surcharge laisse au défaut du backend. La distinction
		// compte maintenant qu'une route hors-ligne hybride ne peut plus passer
		// devant un fournisseur choisi (`core.offline_policy.resolve_offline_route`).
		return credentialManager.getEnvironmentVariables(provider || undefined);
	} catch {
		return {};
	}
}

/** Le fournisseur d'une page, normalisé, ou `""` si aucun n'est choisi. */
export function getPageProvider(page: PageLlmPage): string {
	return normalizeProviderId(getPageLlmConfig(page).provider);
}
