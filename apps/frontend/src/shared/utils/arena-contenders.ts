/**
 * Who may enter the Arena — every model of every provider this machine is
 * actually configured for.
 *
 * The page used to offer four hardcoded names (`DEMO_PROFILES`: a Claude
 * Sonnet, a Claude Haiku, GPT-4.1 and GPT-4.1 Mini) whenever the real list came
 * back empty, which it always did: the real list was `profile:list`, the Claude
 * credential store, which knows nothing about Ollama, Copilot, Mistral or
 * Google. So the arena named models the user may not have, and could not name
 * the ones they do.
 *
 * There is no new detection here. Two answers the app already has are joined:
 * which providers are configured (`getStaticProviders`, the same call the
 * "Fournisseur IA" list is built from) and which models each of them offers
 * (the provider catalog, live from the provider itself and falling back to the
 * generated registry). A provider added to either reaches the Arena with no
 * change to this file.
 */

import type { ArenaContender, ArenaContenderSource } from "../types/arena";

/** A model as the provider catalog reports it. */
export interface CatalogEntry {
	value: string;
	label: string;
	tier?: "flagship" | "standard" | "fast" | "local";
	/** Local providers only: false when the model cannot drive tool calls. */
	supports_tools?: boolean;
	/** Local providers only: whether the model is actually pulled. */
	installed?: boolean;
}

export interface ProviderCatalogInput {
	models: readonly CatalogEntry[];
	source: ArenaContenderSource;
}

export interface BuildContendersInput {
	/** Providers as `getStaticProviders` returns them, in its order. */
	providers: ReadonlyArray<{ name: string; label: string }>;
	/** Which of them are configured. Only these produce contenders. */
	status: Readonly<Record<string, boolean>>;
	/** The catalog of each provider, keyed by provider name. */
	catalogs: Readonly<Record<string, ProviderCatalogInput | undefined>>;
}

/** Providers whose models run on the machine rather than on an account. */
const LOCAL_PROVIDERS = new Set([
	"ollama",
	"local",
	"lmstudio",
	"lm-studio",
	"llama-cpp",
]);

export function isLocalProvider(provider: string): boolean {
	return LOCAL_PROVIDERS.has(provider);
}

/** The stable identity of a contender, and the key every stat is filed under. */
export function contenderId(provider: string, model: string): string {
	return `${provider}:${model}`;
}

/** Split a contender id back into its two halves (the model may contain `:`). */
export function parseContenderId(id: string): {
	provider: string;
	model: string;
} {
	const separator = id.indexOf(":");
	if (separator === -1) return { provider: "", model: id };
	return {
		provider: id.slice(0, separator),
		model: id.slice(separator + 1),
	};
}

/**
 * Every model of every configured provider, provider order preserved.
 *
 * Two kinds of local entry are dropped, both for the same reason: they cannot
 * win a battle, they can only lose one to an error.
 *
 * - a model the backend says cannot drive tool calls, exactly as the model
 *   picker drops it;
 * - a model that is **not pulled**. The picker keeps those as suggestions
 *   because it can start the download; the Arena cannot, so entering one just
 *   spends a battle on `pull model manifest: file does not exist`. That also
 *   settles the unreachable case for free: a local server that is not running
 *   answers with the offline catalogue, where nothing is installed, so it
 *   contributes nobody rather than thirty-five models the machine lacks.
 */
export function buildArenaContenders(
	input: BuildContendersInput,
): ArenaContender[] {
	const contenders: ArenaContender[] = [];
	const seen = new Set<string>();

	for (const provider of input.providers) {
		if (!input.status[provider.name]) continue;
		const catalog = input.catalogs[provider.name];
		if (!catalog) continue;

		for (const model of catalog.models) {
			if (!model?.value) continue;
			if (isLocalProvider(provider.name)) {
				if (model.supports_tools === false) continue;
				if (model.installed !== true) continue;
			}
			const id = contenderId(provider.name, model.value);
			if (seen.has(id)) continue;
			seen.add(id);
			contenders.push({
				id,
				provider: provider.name,
				providerLabel: provider.label,
				model: model.value,
				modelLabel: model.label || model.value,
				tier: model.tier,
				source: catalog.source,
			});
		}
	}

	return contenders;
}

/** Case-insensitive match on the model, the provider, or the id. */
export function filterContenders(
	contenders: readonly ArenaContender[],
	query: string,
): ArenaContender[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...contenders];
	return contenders.filter((contender) =>
		[
			contender.modelLabel,
			contender.model,
			contender.providerLabel,
			contender.provider,
		].some((field) => field.toLowerCase().includes(needle)),
	);
}

const TIER_RANK: Record<string, number> = {
	flagship: 0,
	standard: 1,
	fast: 2,
	local: 3,
};

/**
 * The two contenders a battle opens with.
 *
 * **Different providers first.** Comparing two models of the same vendor is a
 * legitimate battle, but it is not the one somebody opens the Arena to run, and
 * picking the first two of a list sorted by provider would always produce it.
 * Within a provider the best tier goes first, because a flagship against a
 * flagship is the comparison that carries information.
 */
export function pickDefaultContenders(
	contenders: readonly ArenaContender[],
	count = 2,
): string[] {
	const byProvider = new Map<string, ArenaContender[]>();
	for (const contender of contenders) {
		const bucket = byProvider.get(contender.provider) ?? [];
		bucket.push(contender);
		byProvider.set(contender.provider, bucket);
	}
	for (const bucket of byProvider.values()) {
		bucket.sort(
			(a, b) => (TIER_RANK[a.tier ?? ""] ?? 9) - (TIER_RANK[b.tier ?? ""] ?? 9),
		);
	}

	const picked: string[] = [];
	// One pass per rank: the best of each provider, then the second best of
	// each, and so on — so a fourth contender never comes from a provider that
	// has not been drawn from yet.
	for (let rank = 0; picked.length < count; rank++) {
		let drewAny = false;
		for (const bucket of byProvider.values()) {
			if (picked.length >= count) break;
			const contender = bucket[rank];
			if (!contender) continue;
			picked.push(contender.id);
			drewAny = true;
		}
		if (!drewAny) break;
	}
	return picked;
}

/**
 * How many tokens a piece of text is worth, when the provider reported nothing.
 *
 * Four characters per token is the same rule of thumb rtk's ledger uses. It is
 * an estimate and it is labelled as one everywhere it surfaces; the alternative
 * — shipping a tokenizer per provider — buys accuracy nobody is ranking on.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
