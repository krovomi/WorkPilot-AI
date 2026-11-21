/**
 * The session plan the renderer sends (#344) is checked field by field in the
 * main process: providers by name only, budgets as bounded positive numbers
 * that come with their providers, the switch as a boolean.
 */
import { describe, expect, it } from "vitest";
import { parseAgentOrigin, parsePlanRequest } from "../mission-control-plan";

describe("parsePlanRequest", () => {
	it("builds the backend's body for a crew", () => {
		expect(parsePlanRequest({ providers: ["anthropic", "ollama"], budgetUsd: 2.5 })).toEqual({
			ok: true,
			body: { providers: ["anthropic", "ollama"], budget_usd: 2.5, budget_tokens: null },
		});
		expect(
			parsePlanRequest({ providers: ["openai"], budgetTokens: 5000, autoRebalance: true }),
		).toEqual({
			ok: true,
			body: { auto_rebalance: true, providers: ["openai"], budget_usd: null, budget_tokens: 5000 },
		});
	});

	it("takes the switch alone", () => {
		expect(parsePlanRequest({ autoRebalance: false })).toEqual({
			ok: true,
			body: { auto_rebalance: false },
		});
	});

	it.each([
		null,
		"plan",
		{},
		{ autoRebalance: "yes" },
		{ budgetUsd: 1 },
		{ budgetTokens: 10 },
		{ providers: "anthropic" },
		{ providers: [] },
		{ providers: Array.from({ length: 9 }, (_, i) => `p${i}`) },
		{ providers: ["../etc"] },
		{ providers: ["anthropic"], budgetUsd: 0 },
		{ providers: ["anthropic"], budgetUsd: 2_000_000 },
		{ providers: ["anthropic"], budgetUsd: Number.NaN },
		{ providers: ["anthropic"], budgetTokens: 1.5 },
		{ providers: ["anthropic"], budgetTokens: 20_000_000_000 },
		{ providers: ["anthropic"], budgetTokens: -3 },
	])("refuses %j", (request) => {
		expect(parsePlanRequest(request)).toEqual({ ok: false, error: "invalid_plan" });
	});
});

describe("parseAgentOrigin", () => {
	it("defaults to a manual agent", () => {
		expect(parseAgentOrigin({})).toEqual({ origin: "manual", estimated_tokens: 0 });
		expect(parseAgentOrigin({ origin: "auto", estimatedTokens: 1200 })).toEqual({
			origin: "auto",
			estimated_tokens: 1200,
		});
	});

	it.each([
		{ origin: "server" },
		{ estimatedTokens: "1" },
		{ estimatedTokens: 1.5 },
		{ estimatedTokens: -1 },
		{ estimatedTokens: 20_000_000_000 },
	])("refuses %j", (agent) => {
		expect(parseAgentOrigin(agent)).toBeNull();
	});
});
