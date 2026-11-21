import { describe, expect, it } from "vitest";
import { providerDefaultModel } from "../provider-default-model";
import { resolvePhaseDefaults } from "../task-thinking";

describe("providerDefaultModel", () => {
	const settings = {
		globalOllamaModel: " hf.co/org/model ",
		globalOpenRouterModel: "moonshotai/kimi-k3.1-pro",
		globalHuggingFaceModel: "zai-org/GLM-5.3-Flash",
	};

	it("reads the local server's model for every local spelling", () => {
		for (const provider of ["ollama", "local", "lmstudio"]) {
			expect(providerDefaultModel(provider, settings)).toBe("hf.co/org/model");
		}
	});

	it("reads each gateway's own model", () => {
		expect(providerDefaultModel("openrouter", settings)).toBe("moonshotai/kimi-k3.1-pro");
		expect(providerDefaultModel("huggingface", settings)).toBe("zai-org/GLM-5.3-Flash");
	});

	it("has none for another provider, a blank value or no settings", () => {
		expect(providerDefaultModel("openai", settings)).toBeUndefined();
		expect(providerDefaultModel("huggingface", { globalHuggingFaceModel: "  " })).toBeUndefined();
		expect(providerDefaultModel("ollama", undefined)).toBeUndefined();
	});

	it("seeds every phase of a task on the gateway page's model", () => {
		const { phaseModels } = resolvePhaseDefaults(
			{ globalHuggingFaceModel: "zai-org/GLM-5.3-Flash" } as never,
			"huggingface",
		);
		expect(Object.values(phaseModels)).toEqual(Array(4).fill("zai-org/GLM-5.3-Flash"));
	});
});
