/**
 * A helper beside a stuck Mission Control agent (#344): when the backend has
 * nothing left to try and starts a helper instead, the stuck agent records its
 * failure and the helper runs its own task, the one the backend wrote for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../app-logger", () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { OneShotLLMOptions } from "../../oneshot-llm";
import { type MissionControlDeps, startMissionControlAgent, stopMissionControlRun } from "../mission-control-runs";

const ID = "stuck123";
const HELPER = "help4567";
const AGENT = { provider: "anthropic", model: "opus", role: "coder", current_task: "" };
const HELPER_AGENT = {
	provider: "openai",
	model: "gpt-top",
	role: "debugger",
	current_task: "Another agent was given the task below and could not finish it",
};

type Call = { path: string; body?: Record<string, unknown> };
type Reply = { success: boolean; [key: string]: unknown };

function backend(rebalance: Reply | Promise<Reply>, helper: Reply = { success: true, agent: HELPER_AGENT }) {
	const calls: Call[] = [];
	const mock = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
		calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (path.endsWith("/rebalance")) return rebalance;
		if (path.endsWith(`/agents/${HELPER}`)) return helper;
		if (path.endsWith(`/agents/${ID}`)) return { success: true, agent: AGENT };
		return { success: true };
	});
	return { calls, backendFetch: mock as unknown as MissionControlDeps["backendFetch"] };
}

const helperReply = (helperId: string): Reply => ({
	success: true,
	rebalance: { action: "helper", helper_id: helperId },
	agent: { ...AGENT, helper_id: helperId },
});
const updatesOf = (calls: Call[], id: string) =>
	calls.filter((c) => c.path.endsWith(`/agents/${id}/update`)).map((c) => c.body ?? {});
const settle = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000 });

afterEach(() => {
	stopMissionControlRun(ID);
	stopMissionControlRun(HELPER);
	warn.mockClear();
});

describe("a helper beside a stuck agent", () => {
	it("records the failure, then runs the helper on the task the backend wrote", async () => {
		const { calls, backendFetch } = backend(helperReply(HELPER));
		const runOneShotLLM = vi
			.fn<(options: OneShotLLMOptions) => Promise<string | null>>()
			.mockImplementationOnce(async (options) => {
				options.onFailure?.("HTTP 500 from the model");
				return null;
			})
			.mockResolvedValueOnce("FOUND IT");

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "fix the bug", "/proj");

		await settle(() => updatesOf(calls, HELPER).some((u) => u.status === "completed"));
		expect(updatesOf(calls, ID).at(-1)).toEqual({ status: "error", error: "HTTP 500 from the model" });
		const second = runOneShotLLM.mock.calls[1][0];
		expect([second.provider, second.model, second.prompt, second.projectDir]).toEqual([
			"openai",
			"gpt-top",
			HELPER_AGENT.current_task,
			"/proj",
		]);
		expect(calls.find((c) => c.path.endsWith(`/agents/${HELPER}/start`))?.body).toEqual({
			task: HELPER_AGENT.current_task,
		});
	});

	it("starts nothing for a helper id it cannot trust", async () => {
		const { calls, backendFetch } = backend(helperReply("../../session"));
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => null);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");

		await settle(() => updatesOf(calls, ID).some((u) => u.status === "error"));
		expect(runOneShotLLM).toHaveBeenCalledTimes(1);
		expect(calls.some((c) => c.path.includes("session"))).toBe(false);
	});

	it("logs a helper that could not start", async () => {
		const { calls, backendFetch } = backend(helperReply(HELPER), { success: false, error: "Agent not found" });
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => null);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");

		await settle(() => warn.mock.calls.length > 0);
		expect(warn).toHaveBeenCalledWith("[MissionControl] Helper did not start:", "Agent not found");
		expect(updatesOf(calls, ID).at(-1)).toEqual({ status: "error", error: "No response from the provider" });
		expect(runOneShotLLM).toHaveBeenCalledTimes(1);
	});

	it("starts no helper for an agent stopped while the backend decided", async () => {
		let release: (reply: Reply) => void = () => undefined;
		const pending = new Promise<Reply>((resolve) => {
			release = resolve;
		});
		const { calls, backendFetch } = backend(pending);
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => null);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");
		await settle(() => calls.some((c) => c.path.endsWith("/rebalance")));
		stopMissionControlRun(ID);
		release(helperReply(HELPER));

		await settle(() => updatesOf(calls, ID).some((u) => u.status === "error"));
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.some((c) => c.path.includes(HELPER))).toBe(false);
		expect(runOneShotLLM).toHaveBeenCalledTimes(1);
	});
});
