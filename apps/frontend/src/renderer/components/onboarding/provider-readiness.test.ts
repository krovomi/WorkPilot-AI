import { describe, expect, it } from "vitest";
import type { APIProfile } from "../../../shared/types/profile";
import { readyProviderLabels } from "./provider-readiness";

const response = (status: Record<string, boolean>) => ({
	providers: [
		{ name: "anthropic", label: "Anthropic (Claude)", description: "" },
		{ name: "copilot", label: "GitHub Copilot", description: "" },
		{ name: "openai", label: "OpenAI", description: "" },
		{ name: "ollama", label: "Ollama", description: "" },
	],
	status,
});

const profile = (overrides: Partial<APIProfile>): APIProfile => ({
	id: "p1",
	name: "Mon proxy",
	baseUrl: "https://llm.example.org",
	apiKey: "sk-test",
	createdAt: 0,
	updatedAt: 0,
	...overrides,
});

describe("readyProviderLabels", () => {
	it("is empty on a fresh install, Ollama's default included", () => {
		// Ollama is « available » by default: no proof that a server runs.
		expect(readyProviderLabels(response({ ollama: true }), [])).toEqual([]);
	});

	it("names the connected providers in the pickers' order", () => {
		expect(
			readyProviderLabels(response({ anthropic: true, copilot: true, openai: false }), []),
		).toEqual(["Anthropic (Claude)", "GitHub Copilot"]);
	});

	it("counts Ollama once a URL is set", () => {
		expect(
			readyProviderLabels(response({ ollama: true }), [], {
				globalOllamaApiUrl: "http://localhost:11434",
			}),
		).toEqual(["Ollama"]);
	});

	it("counts an API profile on an endpoint no provider lists, by its name", () => {
		expect(readyProviderLabels(response({}), [profile({})])).toEqual(["Mon proxy"]);
	});

	it("ignores a profile without a key", () => {
		expect(readyProviderLabels(response({}), [profile({ apiKey: "  " })])).toEqual([]);
	});
});
