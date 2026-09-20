import { describe, expect, it } from "vitest";
import {
	buildArenaContenders,
	contenderId,
	estimateTokens,
	filterContenders,
	parseContenderId,
	pickDefaultContenders,
} from "../arena-contenders";

const providers = [
	{ name: "anthropic", label: "Anthropic (Claude)" },
	{ name: "openai", label: "OpenAI (ChatGPT)" },
	{ name: "ollama", label: "Ollama (Local)" },
];

const catalogs = {
	anthropic: {
		source: "live" as const,
		models: [
			{ value: "claude-opus-5", label: "Claude Opus 5", tier: "flagship" as const },
			{ value: "claude-haiku-4-5", label: "Claude Haiku 4.5", tier: "fast" as const },
		],
	},
	openai: {
		source: "live" as const,
		models: [
			{ value: "gpt-5", label: "GPT-5", tier: "flagship" as const },
			{ value: "gpt-5-mini", label: "GPT-5 mini", tier: "fast" as const },
		],
	},
	ollama: {
		source: "live" as const,
		models: [
			{
				value: "llama3.3",
				label: "Llama 3.3",
				tier: "local" as const,
				installed: true,
			},
			{
				value: "embed-only",
				label: "Embed Only",
				tier: "local" as const,
				installed: true,
				supports_tools: false,
			},
			{
				value: "not-pulled",
				label: "Not Pulled",
				tier: "local" as const,
				installed: false,
			},
		],
	},
};

describe("buildArenaContenders", () => {
	it("lists every model of every configured provider", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { anthropic: true, openai: true, ollama: true },
			catalogs,
		});
		expect(contenders.map((c) => c.id)).toEqual([
			"anthropic:claude-opus-5",
			"anthropic:claude-haiku-4-5",
			"openai:gpt-5",
			"openai:gpt-5-mini",
			"ollama:llama3.3",
		]);
	});

	it("ignores a provider that is not configured", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { anthropic: true, openai: false, ollama: false },
			catalogs,
		});
		expect(contenders.every((c) => c.provider === "anthropic")).toBe(true);
	});

	it("drops a local model that cannot drive tool calls", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { ollama: true },
			catalogs,
		});
		expect(contenders.map((c) => c.model)).not.toContain("embed-only");
	});

	it("drops a local model that is not pulled — the arena cannot download it", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { ollama: true },
			catalogs,
		});
		expect(contenders.map((c) => c.model)).toEqual(["llama3.3"]);
	});

	it("contributes nobody when the local server is unreachable", () => {
		// The offline catalogue lists models the machine may not have; entering
		// one spends a battle on a failed pull.
		const contenders = buildArenaContenders({
			providers,
			status: { ollama: true },
			catalogs: {
				ollama: {
					source: "static" as const,
					models: [{ value: "llama3.3", label: "Llama 3.3", tier: "local" as const }],
				},
			},
		});
		expect(contenders).toEqual([]);
	});

	it("carries the provider label and the catalog provenance", () => {
		const [first] = buildArenaContenders({
			providers,
			status: { anthropic: true },
			catalogs: {
				anthropic: { ...catalogs.anthropic, source: "static" as const },
			},
		});
		expect(first.providerLabel).toBe("Anthropic (Claude)");
		expect(first.source).toBe("static");
	});

	it("returns nothing when no provider is configured", () => {
		expect(
			buildArenaContenders({ providers, status: {}, catalogs }),
		).toEqual([]);
	});
});

describe("contenderId", () => {
	it("round-trips a model id that contains a colon", () => {
		const id = contenderId("ollama", "qwen2.5-coder:7b");
		expect(parseContenderId(id)).toEqual({
			provider: "ollama",
			model: "qwen2.5-coder:7b",
		});
	});
});

describe("pickDefaultContenders", () => {
	it("opens on two different providers rather than two models of one", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { anthropic: true, openai: true, ollama: true },
			catalogs,
		});
		const picked = pickDefaultContenders(contenders, 2);
		expect(picked).toHaveLength(2);
		const pickedProviders = picked.map((id) => parseContenderId(id).provider);
		expect(new Set(pickedProviders).size).toBe(2);
	});

	it("prefers the best tier within each provider", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { anthropic: true, openai: true },
			catalogs,
		});
		expect(pickDefaultContenders(contenders, 2)).toEqual([
			"anthropic:claude-opus-5",
			"openai:gpt-5",
		]);
	});

	it("falls back to a second model of the same provider when it is the only one", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { anthropic: true },
			catalogs,
		});
		expect(pickDefaultContenders(contenders, 2)).toEqual([
			"anthropic:claude-opus-5",
			"anthropic:claude-haiku-4-5",
		]);
	});

	it("returns what it has when the roster is too small to fill the count", () => {
		const contenders = buildArenaContenders({
			providers,
			status: { ollama: true },
			catalogs,
		});
		expect(pickDefaultContenders(contenders, 2)).toEqual(["ollama:llama3.3"]);
	});
});

describe("filterContenders", () => {
	const contenders = buildArenaContenders({
		providers,
		status: { anthropic: true, openai: true, ollama: true },
		catalogs,
	});

	it("matches on the model label, case-insensitively", () => {
		expect(filterContenders(contenders, "HAIKU").map((c) => c.model)).toEqual([
			"claude-haiku-4-5",
		]);
	});

	it("matches on the provider, so a whole vendor can be listed", () => {
		expect(filterContenders(contenders, "openai")).toHaveLength(2);
	});

	it("returns everything for an empty query", () => {
		expect(filterContenders(contenders, "  ")).toHaveLength(contenders.length);
	});
});

describe("estimateTokens", () => {
	it("is a length-based estimate, never negative", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});
