/**
 * Per-model pricing in USD per 1M tokens, for live cost previews in the
 * renderer (where the backend isn't reachable as the user types).
 *
 * The prices come from `apps/backend/cost_intelligence/catalog.py`, read from
 * each provider's official pricing page, through `model-pricing.generated.json`
 * (`python scripts/generate_model_catalog.py`, checked by `--check` and by
 * tests/cost_intelligence/test_catalog.py). Change a price in the catalog,
 * never here. Only input/output rates are mirrored: the panels that consume
 * this estimate only have generic input+output token budgets to work with.
 */

import { MODEL_ID_MAP } from "../../shared/constants/models";
import generated from "../../shared/constants/model-pricing.generated.json";

export interface ModelPricing {
	/** Provider key (lower-case), matching `selectedProvider` in ProviderContext. */
	provider: string;
	/** Model identifier as exposed by the provider. */
	model: string;
	/** USD per 1M input tokens. */
	input: number;
	/** USD per 1M output tokens. */
	output: number;
}

type Rates = { input: number; output: number };

const PRICES: Record<string, Record<string, Rates>> = generated.prices;
const FLAT_RATE_PROVIDERS = new Set<string>(generated.flatRateProviders);

// Aliases (provider name normalisation).
const PROVIDER_ALIASES: Record<string, string> = {
	claude: "anthropic",
};

// What may follow a catalog key in a model id that still names the keyed
// model — the rule of `_SNAPSHOT_SUFFIX` in catalog.py: a date or build number
// (-20251101, -2025-08-07, -0709, -001), -latest, -preview, -exp, -beta,
// xAI's -reasoning / -non-reasoning, a Bedrock version (-v1:0), a Vertex
// version (@20251101), a local tag (:70b), Claude's [1m]. Anything else is
// another model at another price (gpt-5 → gpt-5.5, gpt-5.5 → gpt-5.5-mini).
const TAG = String.raw`latest|preview|exp|experimental|beta|reasoning|non-reasoning|v\d+(?::\d+)?`;
const SNAPSHOT_SUFFIX = new RegExp(
	String.raw`^(?:-(?:\d{3,}|${TAG})(?:-(?:\d+|${TAG}))*)?(?:[@:].*|\[1m\])?$`,
);

/**
 * Look up pricing for a (provider, model) pair, as the Python catalog does:
 * an exact key wins, then the longest key the model id extends with a
 * snapshot suffix ("claude-opus-4-5-20251101" → "claude-opus-4-5"). A key never
 * prices a shorter id nor a later version of itself. A model of a flat-rate
 * provider (Copilot, Windsurf, Cursor, Ollama) costs $0 a token, listed or not.
 *
 * Returns `null` when nothing matches — callers should treat that as
 * "unknown pricing", not "free".
 */
export function getModelPricing(
	provider: string | undefined | null,
	model: string | undefined | null,
): ModelPricing | null {
	if (!provider || !model) return null;
	const key = PROVIDER_ALIASES[provider.toLowerCase()] ?? provider.toLowerCase();
	const models = PRICES[key];
	// Shorthand aliases ("sonnet", "opus-5") stand for full Claude ids.
	const id = key === "anthropic" ? (MODEL_ID_MAP[model] ?? model) : model;

	const exact = models?.[id];
	if (exact) return { provider: key, model: id, ...exact };

	let best = "";
	for (const candidate of Object.keys(models ?? {})) {
		if (
			candidate.length > best.length &&
			id.startsWith(candidate) &&
			SNAPSHOT_SUFFIX.test(id.slice(candidate.length))
		) {
			best = candidate;
		}
	}
	if (models && best) return { provider: key, model: best, ...models[best] };
	if (FLAT_RATE_PROVIDERS.has(key)) {
		return { provider: key, model: id, input: 0, output: 0 };
	}
	return null;
}

/**
 * Whether a given (provider, model) is billed per token (true) or under a
 * flat-rate seat licence (false). Cursor / Windsurf / Copilot / Ollama all
 * fall in the latter bucket.
 */
export function isPerTokenBilled(
	provider: string | undefined | null,
	model: string | undefined | null,
): boolean {
	const p = getModelPricing(provider, model);
	if (!p) return false;
	return p.input > 0 || p.output > 0;
}

/**
 * Estimate USD cost for a given input + output token split.
 *
 * `outputRatio` defaults to 0.25 — i.e. for a 8000-token budget, assume the
 * model emits 2000 output tokens against 6000 input tokens. This is a
 * reasonable default for "extract relevant context" workloads but callers
 * can override it when they have better signal.
 */
export function estimateUsdCost(
	pricing: ModelPricing,
	totalTokens: number,
	outputRatio = 0.25,
): { input: number; output: number; total: number } {
	const safeRatio = Math.max(0, Math.min(1, outputRatio));
	const outputTokens = Math.round(totalTokens * safeRatio);
	const inputTokens = Math.max(0, totalTokens - outputTokens);
	const inputCost = (inputTokens * pricing.input) / 1_000_000;
	const outputCost = (outputTokens * pricing.output) / 1_000_000;
	return {
		input: inputCost,
		output: outputCost,
		total: inputCost + outputCost,
	};
}
