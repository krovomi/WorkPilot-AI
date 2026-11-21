/**
 * How the Formula Lab writes a cost, a token count, a model and an effort, and
 * which colour a provider gets. The Kanban board and the task engine chip read
 * the same helpers.
 */
import { describe, expect, it } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	effortLabel,
	formatCost,
	formatCostBand,
	formatTokens,
	providerColor,
	shortModel,
} from "../formula-utils";

describe("formula-utils", () => {
	it("writes a USD cost in euros, with more digits under a cent", () => {
		expect(formatCost(0)).toBe("€0");
		expect(formatCost(-1)).toBe("€0");
		expect(formatCost(0.005)).toBe("~€0.0046");
		expect(formatCost(1)).toBe("€0.92");
	});

	it("writes a free formula's band as a single €0", () => {
		const band = { expected_cost_usd: 0, low_cost_usd: 0, high_cost_usd: 0 };
		expect(formatCostBand(band as Parameters<typeof formatCostBand>[0])).toBe("€0");
		const paid = { expected_cost_usd: 1, low_cost_usd: 0.5, high_cost_usd: 2 };
		expect(formatCostBand(paid as Parameters<typeof formatCostBand>[0])).toBe(
			"€0.46–€1.84",
		);
	});

	it("shortens token counts", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(12_400)).toBe("12k");
		expect(formatTokens(3_250_000)).toBe("3.3M");
	});

	it("strips vendor prefixes and date suffixes from model names", () => {
		expect(shortModel("anthropic.claude-opus-5-20260101")).toBe("opus-5");
		expect(shortModel("meta.llama-4")).toBe("llama-4");
		expect(shortModel("gpt-5.5")).toBe("gpt-5.5");
	});

	it("gives each known provider its colour, and others a default", () => {
		expect(providerColor("Anthropic")).toBe("#d97757");
		expect(providerColor("unknown-vendor")).toBe("#8b5cf6");
	});

	it("translates known effort levels and keeps others as they come", async () => {
		await i18n.changeLanguage("fr");
		const t = i18n.t.bind(i18n);
		expect(effortLabel("high", t)).toBe("Élevé");
		expect(effortLabel("custom", t)).toBe("custom");
		await i18n.changeLanguage("en");
		expect(effortLabel("medium", t)).toBe("Med");
	});
});
