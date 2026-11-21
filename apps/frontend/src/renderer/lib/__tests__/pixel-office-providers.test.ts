/**
 * A character wears the colour of the provider family running its task's
 * current phase; an unknown provider is "custom", none is no colour.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskMetadata } from "../../../shared/types/task";
import {
	enginePhaseOf,
	FAMILY_SHIRTS,
	isProviderFamily,
	PROVIDER_FAMILIES,
	phaseFamily,
	providerFamilyOf,
	taskProviderFamily,
} from "../pixel-office-providers";

function task(metadata: TaskMetadata | undefined, phase?: string): Task {
	return {
		id: "t",
		specId: "001-t",
		projectId: "p",
		title: "t",
		description: "",
		status: "in_progress",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		metadata,
		executionProgress: phase ? ({ phase } as Task["executionProgress"]) : undefined,
	};
}

describe("providerFamilyOf", () => {
	it.each([
		["anthropic", "anthropic"],
		["Claude", "anthropic"],
		["openai", "openai"],
		["gemini", "google"],
		["ollama", "ollama"],
		["copilot", "copilot"],
		["xai", "grok"],
		["mistral", "custom"],
	])("files %s under %s", (provider, family) => {
		expect(providerFamilyOf(provider)).toBe(family);
	});

	it("names no family for no provider", () => {
		expect(providerFamilyOf(undefined)).toBeUndefined();
		expect(providerFamilyOf("  ")).toBeUndefined();
	});

	it("has a shirt for every family, and knows them", () => {
		for (const family of PROVIDER_FAMILIES) {
			expect(FAMILY_SHIRTS[family]).toMatch(/^#[0-9A-F]{6}$/);
			expect(isProviderFamily(family)).toBe(true);
		}
		expect(isProviderFamily("meta")).toBe(false);
	});
});

describe("taskProviderFamily", () => {
	const metadata: TaskMetadata = {
		provider: "anthropic",
		phaseProviders: { spec: "anthropic", planning: "google", coding: "openai", qa: "ollama" },
	};

	it("reads the provider of the phase the task is in", () => {
		expect(taskProviderFamily(task(metadata, "planning"))).toBe("google");
		expect(taskProviderFamily(task(metadata, "coding"))).toBe("openai");
		expect(taskProviderFamily(task(metadata, "qa_review"))).toBe("ollama");
		expect(taskProviderFamily(task(metadata, "qa_fixing"))).toBe("ollama");
		expect(taskProviderFamily(task(metadata))).toBe("openai");
	});

	it("falls back on the task's provider, and on nothing", () => {
		expect(taskProviderFamily(task({ provider: "copilot" }, "planning"))).toBe("copilot");
		expect(taskProviderFamily(task(undefined, "coding"))).toBeUndefined();
	});

	it("maps execution phases to engine phases", () => {
		expect(enginePhaseOf(task(undefined, "planning"))).toBe("planning");
		expect(enginePhaseOf(task(undefined, "complete"))).toBe("coding");
		expect(phaseFamily(task(metadata), "qa")).toBe("ollama");
	});
});
