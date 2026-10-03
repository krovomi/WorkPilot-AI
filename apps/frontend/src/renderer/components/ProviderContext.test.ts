import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import { runningProvidersKey } from "./ProviderContext";

function task(partial: Partial<Task>): Task {
	return { id: "t", status: "in_progress", metadata: {}, ...partial } as Task;
}

describe("runningProvidersKey", () => {
	it("lists the provider of each running phase, once, with Claude spelled as the badges spell it", () => {
		const tasks = [
			task({
				executionProgress: { phase: "coding" } as Task["executionProgress"],
				metadata: {
					provider: "openai",
					phaseProviders: {
						spec: "openai",
						planning: "openai",
						coding: "claude",
						qa: "openai",
					},
				},
			}),
			task({
				status: "ai_review",
				executionProgress: { phase: "qa_review" } as Task["executionProgress"],
				metadata: { provider: "ollama" },
			}),
			task({ metadata: { provider: "anthropic" } }),
		];
		expect(runningProvidersKey(tasks)).toBe("anthropic,ollama");
	});

	it("leaves out tasks that are not running or are paused", () => {
		const tasks = [
			task({ status: "backlog", metadata: { provider: "openai" } }),
			task({
				metadata: { provider: "mistral", paused: { enabled: true } },
			}),
		];
		expect(runningProvidersKey(tasks)).toBe("");
	});
});
