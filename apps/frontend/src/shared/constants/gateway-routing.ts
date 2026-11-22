/**
 * The routing options of a gateway, set on its provider page, and the
 * environment variables that carry them to the backend
 * (`apps/backend/gateway_routing.py`, which reads them again against the
 * same closed lists).
 *
 * - OpenRouter: fallback models tried in order, a provider order (price,
 *   throughput, latency), and two privacy filters (providers that do not
 *   store prompts; zero data retention).
 * - Hugging Face: the router's policy, `fastest` or `cheapest`.
 */
import type { AppSettings } from "../types/settings";

export const OPENROUTER_SORTS = ["price", "throughput", "latency"] as const;
export type OpenRouterSort = (typeof OPENROUTER_SORTS)[number];

export const HUGGINGFACE_POLICIES = ["fastest", "cheapest"] as const;
export type HuggingFacePolicy = (typeof HUGGINGFACE_POLICIES)[number];

/** Fallbacks kept after the chosen model. */
export const MAX_FALLBACK_MODELS = 3;

/** `vendor/model`, with the dots, dashes, colons and `@` gateway ids carry. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._\-:@]*$/;

export type GatewayRoutingSettings = Pick<
	AppSettings,
	| "openRouterSort"
	| "openRouterFallbackModels"
	| "openRouterDenyDataCollection"
	| "openRouterZeroRetention"
	| "huggingFaceRoutingPolicy"
>;

export function isGatewayModelId(value: string): boolean {
	return value.length <= 200 && MODEL_ID.test(value);
}

/** Valid ids, trimmed, without repeats, at most `MAX_FALLBACK_MODELS`. */
export function cleanFallbackModels(values: readonly unknown[] | undefined): string[] {
	const out: string[] = [];
	for (const value of values ?? []) {
		const id = typeof value === "string" ? value.trim() : "";
		if (id && isGatewayModelId(id) && !out.includes(id)) out.push(id);
	}
	return out.slice(0, MAX_FALLBACK_MODELS);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
	return list.find((item) => item === value);
}

/** The environment variables of the provider's routing options; empty when none is set. */
export function gatewayRoutingEnv(
	provider: string,
	settings: GatewayRoutingSettings | undefined,
): Record<string, string> {
	const env: Record<string, string> = {};
	if (provider === "openrouter") {
		const fallbacks = cleanFallbackModels(settings?.openRouterFallbackModels);
		if (fallbacks.length) env.OPENROUTER_FALLBACK_MODELS = fallbacks.join(",");
		const sort = oneOf(OPENROUTER_SORTS, settings?.openRouterSort);
		if (sort) env.OPENROUTER_PROVIDER_SORT = sort;
		if (settings?.openRouterDenyDataCollection === true) {
			env.OPENROUTER_DATA_COLLECTION = "deny";
		}
		if (settings?.openRouterZeroRetention === true) env.OPENROUTER_ZDR = "1";
	} else if (provider === "huggingface") {
		const policy = oneOf(HUGGINGFACE_POLICIES, settings?.huggingFaceRoutingPolicy);
		if (policy) env.HUGGINGFACE_ROUTING_POLICY = policy;
	}
	return env;
}
