import { beforeEach, describe, expect, it, vi } from "vitest";

const found = { task: undefined as unknown, project: undefined as unknown };
const settings = { value: undefined as unknown };
const order = { value: [] as unknown };

vi.mock("../../ipc-handlers/task/shared", () => ({ findTaskAndProject: () => found }));
vi.mock("../../ipc-handlers/task/resume-task", () => ({
	getSpecPaths: () => ({ main: "/specs/main", worktree: "/specs/wt" }),
	allSpecDirs: () => ["/specs/main", "/specs/wt"],
	currentPausePhase: () => "coding",
}));
vi.mock("../../settings-utils", () => ({ readSettingsFile: () => settings.value }));
vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => ({ getAccountPriorityOrder: () => order.value }),
}));
vi.mock("../../agent/task-provider-env", () => ({
	taskEngineFromMetadata: (metadata: { engine?: Record<string, string> } | undefined) => {
		const provider = (phase: string) => ({ provider: metadata?.engine?.[phase] ?? "anthropic" });
		return { spec: provider("spec"), planning: provider("planning"), coding: provider("coding"), qa: provider("qa") };
	},
}));

import {
	accountPinKey,
	chainHasOtherProvider,
	excludedEntries,
	pinnedAccountOf,
	stoppedTask,
	taskPhaseProvider,
} from "../task-phase-provider";

beforeEach(() => {
	found.task = undefined;
	found.project = undefined;
	settings.value = undefined;
	order.value = [];
});

describe("excludedEntries", () => {
	it("reads the text entries of the settings, and nothing when there are none", () => {
		expect(excludedEntries()).toEqual([]);
		settings.value = { disabledAutoSwitchProviders: ["copilot", 3, "oauth-a"] };
		expect(excludedEntries()).toEqual(["copilot", "oauth-a"]);
		settings.value = { disabledAutoSwitchProviders: "copilot" };
		expect(excludedEntries()).toEqual([]);
	});
});

describe("stoppedTask", () => {
	it("is null for an unknown task", () => {
		expect(stoppedTask("t1")).toBeNull();
		expect(taskPhaseProvider("t1")).toBeNull();
	});

	it("names the provider of the phase the task stopped in", () => {
		found.task = { metadata: { engine: { coding: " Copilot " } } };
		found.project = { id: "p1", settings: {} };
		expect(stoppedTask("t1")).toEqual({ provider: "copilot", projectId: "p1", specDirs: ["/specs/main", "/specs/wt"] });
		found.task = { metadata: { engine: { qa: "openai" }, paused: { paused_phase: "qa_review" } } };
		expect(taskPhaseProvider("t1", "p1")).toBe("openai");
	});
});

describe("the account a stopped task is pinned to", () => {
	it("reads the task's pin first, then its project's, under the provider's key", () => {
		found.task = { metadata: { engine: { coding: "gemini" }, aiAccounts: { google: "g-task" } } };
		found.project = { id: "p1", settings: { aiAccounts: { google: "g-project", claude: "work" } } };
		expect(stoppedTask("t1")).toMatchObject({ provider: "gemini", pinKey: "google", pinnedAccount: "g-task" });
		found.task = { metadata: { engine: { coding: "gemini" } } };
		expect(stoppedTask("t1")).toMatchObject({ pinKey: "google", pinnedAccount: "g-project" });
		found.task = { metadata: {} };
		expect(stoppedTask("t1")).toMatchObject({ provider: "anthropic", pinKey: "claude", pinnedAccount: "work" });
	});

	it("has no pin for a provider without accounts, nor for a pin that is not text", () => {
		found.task = { metadata: { engine: { coding: "copilot" }, aiAccounts: { copilot: "x" } } };
		found.project = { id: "p1", settings: {} };
		expect(stoppedTask("t1")).toMatchObject({ pinKey: undefined, pinnedAccount: undefined });
		expect(accountPinKey("claude")).toBe("claude");
		expect(accountPinKey("ollama")).toBeUndefined();
		expect(pinnedAccountOf({ openai: 3 }, "openai")).toBeUndefined();
		expect(pinnedAccountOf({ openai: "" }, "openai")).toBeUndefined();
		expect(pinnedAccountOf(["openai"], "openai")).toBeUndefined();
		expect(pinnedAccountOf(null, "openai")).toBeUndefined();
	});
});

describe("chainHasOtherProvider", () => {
	it("is true only for a provider other than Claude, known and still in the chain", () => {
		order.value = ["oauth-a", "provider-anthropic", "provider-nope"];
		expect(chainHasOtherProvider()).toBe(false);
		order.value = ["oauth-a", "provider-copilot"];
		expect(chainHasOtherProvider()).toBe(true);
		settings.value = { disabledAutoSwitchProviders: ["provider-copilot"] };
		expect(chainHasOtherProvider()).toBe(false);
		order.value = "not a list";
		expect(chainHasOtherProvider()).toBe(false);
	});
});
