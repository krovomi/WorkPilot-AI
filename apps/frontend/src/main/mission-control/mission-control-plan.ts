/**
 * Mission Control's session plan (#344): the providers a composed crew was
 * made on (where live rebalancing may move an agent) and the budget it holds
 * to, or the switch that turns automatic rebalancing off. The renderer's
 * request is checked field by field here; the backend checks it again.
 */

import { isPositive, isProviderName, MAX_PROVIDERS } from "./mission-control-composition";

const MAX_BUDGET_USD = 1_000_000;
const MAX_BUDGET_TOKENS = 10_000_000_000;

export type ParsedPlan = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** The backend's body for a plan request, or `invalid_plan`. */
export function parsePlanRequest(request: unknown): ParsedPlan {
	const refused: ParsedPlan = { ok: false, error: "invalid_plan" };
	if (!request || typeof request !== "object") return refused;
	const r = request as Record<string, unknown>;
	const body: Record<string, unknown> = {};

	if (r.autoRebalance !== undefined) {
		if (typeof r.autoRebalance !== "boolean") return refused;
		body.auto_rebalance = r.autoRebalance;
	}
	const { providers, budgetUsd, budgetTokens } = r;
	if (providers === undefined) {
		// A budget is the crew's: it comes with its providers or not at all.
		if (budgetUsd !== undefined || budgetTokens !== undefined) return refused;
		return Object.keys(body).length > 0 ? { ok: true, body } : refused;
	}
	if (
		!Array.isArray(providers) ||
		providers.length === 0 ||
		providers.length > MAX_PROVIDERS ||
		!providers.every(isProviderName)
	) {
		return refused;
	}
	if (budgetUsd !== undefined && !(isPositive(budgetUsd) && budgetUsd <= MAX_BUDGET_USD)) {
		return refused;
	}
	if (
		budgetTokens !== undefined &&
		!(isPositive(budgetTokens) && Number.isInteger(budgetTokens) && budgetTokens <= MAX_BUDGET_TOKENS)
	) {
		return refused;
	}
	return {
		ok: true,
		body: { ...body, providers, budget_usd: budgetUsd ?? null, budget_tokens: budgetTokens ?? null },
	};
}

/** The origin and estimate of a new agent, or null when either is malformed. */
export function parseAgentOrigin(
	agent: Record<string, unknown>,
): { origin: "manual" | "auto"; estimated_tokens: number } | null {
	const origin = agent.origin ?? "manual";
	const estimated = agent.estimatedTokens ?? 0;
	if (origin !== "manual" && origin !== "auto") return null;
	if (
		typeof estimated !== "number" ||
		!Number.isInteger(estimated) ||
		estimated < 0 ||
		estimated > MAX_BUDGET_TOKENS
	) {
		return null;
	}
	return { origin, estimated_tokens: estimated };
}
