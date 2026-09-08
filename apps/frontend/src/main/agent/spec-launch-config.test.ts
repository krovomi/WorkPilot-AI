import { describe, expect, it } from "vitest";
import { buildSpecModelArgs } from "./spec-launch-config";

describe("spec launch arguments", () => {
	it("uses the visible planning selection for an old divergent task", () => {
		expect(
			buildSpecModelArgs({
				isAutoProfile: true,
				provider: "ollama",
				phaseModels: {
					spec: "llama3.3",
					planning: "qwen3-coder:30b",
					coding: "qwen2.5-coder:7b",
					qa: "qwen3:8b",
				},
				phaseThinking: {
					spec: "ultrathink",
					planning: "low",
					coding: "low",
					qa: "low",
				},
			}),
		).toEqual([
			"--provider",
			"ollama",
			"--model",
			"qwen3-coder:30b",
			"--thinking-level",
			"low",
		]);
	});
	it("preserves single-model task configuration", () => {
		expect(
			buildSpecModelArgs({
				provider: "ollama",
				model: "qwen3:8b",
				thinkingLevel: "medium",
			}),
		).toEqual([
			"--provider",
			"ollama",
			"--model",
			"qwen3:8b",
			"--thinking-level",
			"medium",
		]);
	});
});
