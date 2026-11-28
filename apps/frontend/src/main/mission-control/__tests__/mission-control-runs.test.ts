/**
 * Mission Control: starting an agent calls its model and reports the answer.
 *
 * It used to mark the agent "running" in the backend and nothing else, so the
 * card waited forever at 0 tokens. These tests drive the run with a fake
 * backend and a fake one-shot runner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app-logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { OneShotLLMOptions } from "../../oneshot-llm";
import {
	isAgentId,
	isRunning,
	type MissionControlDeps,
	rolePrompt,
	startMissionControlAgent,
	stopMissionControlRun,
} from "../mission-control-runs";

type Call = { path: string; body?: Record<string, unknown> };

function fakeBackend(agent: Record<string, unknown>) {
	const calls: Call[] = [];
	const backendFetch = vi.fn(async (path: string, init?: RequestInit) => {
		calls.push({
			path,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		if (path.endsWith("/update") || path.endsWith("/start")) {
			return { success: true as const };
		}
		return { success: true as const, agent };
	}) as unknown as MissionControlDeps["backendFetch"];
	return { calls, backendFetch };
}

const AGENT = {
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	role: "coder",
	current_task: "",
};

async function settle(predicate: () => boolean) {
	await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2000 });
}

const updates = (calls: Call[]) =>
	calls.filter((c) => c.path.endsWith("/update")).map((c) => c.body ?? {});

afterEach(() => {
	stopMissionControlRun("abc12345");
});

describe("startMissionControlAgent", () => {
	it("runs the agent's own provider and model and streams the answer back", async () => {
		const { calls, backendFetch } = fakeBackend(AGENT);
		let seen: OneShotLLMOptions | undefined;
		const runOneShotLLM = vi.fn(async (options: OneShotLLMOptions) => {
			seen = options;
			options.onDelta?.("HEL");
			options.onDelta?.("LO");
			options.onUsage?.({ inputTokens: 10, outputTokens: 2, costUsd: 0.001 });
			return "HELLO";
		});

		const result = await startMissionControlAgent(
			{ backendFetch, runOneShotLLM },
			"abc12345",
			"say HELLO",
		);

		expect(result).toEqual({ success: true });
		await settle(() => updates(calls).some((u) => u.status === "completed"));
		expect(seen?.provider).toBe("anthropic");
		expect(seen?.model).toBe("claude-sonnet-4-5");
		expect(seen?.prompt).toBe("say HELLO");
		expect(seen?.systemPrompt).toBe(rolePrompt("coder"));
		// Never answered by another vendor under this provider's name.
		expect(seen?.requireProvider).toBe(true);
		const sent = updates(calls);
		expect(
			sent
				.map((u) => u.output_delta)
				.filter(Boolean)
				.join(""),
		).toBe("HELLO");
		expect(sent).toContainEqual({
			input_tokens: 10,
			output_tokens: 2,
			cost_usd: 0.001,
		});
		expect(sent.at(-1)).toEqual({ status: "completed", progress: 1 });
		expect(calls.find((c) => c.path.endsWith("/start"))?.body).toEqual({
			task: "say HELLO",
		});
		expect(isRunning("abc12345")).toBe(false);
	});

	it("sends the whole text when the client did not stream", async () => {
		const { calls, backendFetch } = fakeBackend(AGENT);
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => "HELLO");

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, "abc12345", "x");

		await settle(() => updates(calls).some((u) => u.status === "completed"));
		expect(updates(calls)).toContainEqual({ output_delta: "HELLO" });
	});

	it("reports the provider's reason when nothing came back", async () => {
		const { calls, backendFetch } = fakeBackend({ ...AGENT, provider: "meta" });
		const runOneShotLLM = vi.fn(async (options: OneShotLLMOptions) => {
			options.onFailure?.("Provider 'meta' has no adapter of its own here");
			return null;
		});

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, "abc12345", "x");

		await settle(() => updates(calls).some((u) => u.status === "error"));
		expect(updates(calls).at(-1)).toEqual({
			status: "error",
			error: "Provider 'meta' has no adapter of its own here",
		});
	});

	it("gives a CLI provider the project and a throwaway spec directory", async () => {
		const { calls, backendFetch } = fakeBackend({ ...AGENT, provider: "pi" });
		let seen: OneShotLLMOptions | undefined;
		const runOneShotLLM = vi.fn(async (options: OneShotLLMOptions) => {
			seen = options;
			return "ok";
		});

		await startMissionControlAgent(
			{ backendFetch, runOneShotLLM },
			"abc12345",
			"x",
			"/projects/demo",
		);

		await settle(() => updates(calls).some((u) => u.status === "completed"));
		expect(seen?.projectDir).toBe("/projects/demo");
		expect(seen?.specDir).toMatch(/wp-mission-control-/);
	});

	it("reruns the last task when restarted without one", async () => {
		const { calls, backendFetch } = fakeBackend({ ...AGENT, current_task: "say HELLO" });
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => "HELLO");

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, "abc12345", "");

		await settle(() => updates(calls).some((u) => u.status === "completed"));
		expect(runOneShotLLM.mock.calls[0][0].prompt).toBe("say HELLO");
	});

	it("refuses an agent with no task and no provider", async () => {
		const { backendFetch } = fakeBackend(AGENT);
		const runOneShotLLM = vi.fn();

		expect(
			await startMissionControlAgent({ backendFetch, runOneShotLLM }, "abc12345", " "),
		).toEqual({ success: false, error: "A task is required" });

		const noProvider = fakeBackend({ ...AGENT, provider: "" });
		expect(
			await startMissionControlAgent(
				{ backendFetch: noProvider.backendFetch, runOneShotLLM },
				"abc12345",
				"x",
			),
		).toEqual({ success: false, error: "This agent has no provider" });
		expect(runOneShotLLM).not.toHaveBeenCalled();
	});

	it("stops the run without reporting it as a failure", async () => {
		const { calls, backendFetch } = fakeBackend(AGENT);
		let aborted = false;
		const runOneShotLLM = vi.fn(
			(options: OneShotLLMOptions) =>
				new Promise<string | null>((resolve) => {
					options.signal?.addEventListener("abort", () => {
						aborted = true;
						options.onFailure?.("Stopped");
						resolve(null);
					});
				}),
		);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, "abc12345", "x");
		await settle(() => runOneShotLLM.mock.calls.length === 1);
		expect(isRunning("abc12345")).toBe(true);

		expect(stopMissionControlRun("abc12345")).toBe(true);

		await settle(() => aborted);
		await new Promise((r) => setTimeout(r, 20));
		expect(updates(calls).some((u) => "status" in u)).toBe(false);
		expect(isRunning("abc12345")).toBe(false);
	});
});

describe("isAgentId", () => {
	it("accepts the backend's ids and nothing that could change the route", () => {
		expect(isAgentId("abc12345")).toBe(true);
		for (const bad of ["", "../state", "a/b", "a?b=1", 42, null, "x".repeat(65)]) {
			expect(isAgentId(bad)).toBe(false);
		}
	});
});
