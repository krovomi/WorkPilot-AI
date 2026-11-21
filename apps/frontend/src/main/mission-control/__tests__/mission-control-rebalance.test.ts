/**
 * Live rebalancing of a Mission Control run (#344): a run that fails, or whose
 * answer the backend sees looping, is handed to `/rebalance` before its
 * failure is recorded; when the backend moves the agent, the same task starts
 * again on the new model, and when it does not, the failure is recorded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app-logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { OneShotLLMOptions } from "../../oneshot-llm";
import {
	isRunning,
	type MissionControlDeps,
	startMissionControlAgent,
	stopMissionControlRun,
} from "../mission-control-runs";

const ID = "abc12345";
const AGENT = { provider: "anthropic", model: "haiku", role: "coder", current_task: "" };
const MOVED = { ...AGENT, provider: "openai", model: "gpt-standard" };

type Call = { path: string; body?: Record<string, unknown> };
type Reply = { success: boolean; [key: string]: unknown };

interface Script {
	rebalance?: Reply;
	/** The reply to the second /start, the one after a rebalancing. */
	restart?: Reply;
	/** The reply to an output update. */
	update?: Reply;
}

function backend(script: Script) {
	const calls: Call[] = [];
	let starts = 0;
	const mock = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path, body });
		if (path.endsWith("/rebalance")) return script.rebalance ?? { success: true };
		if (path.endsWith("/start")) {
			starts += 1;
			return starts > 1 && script.restart ? script.restart : { success: true };
		}
		if (path.endsWith("/update")) {
			return body?.output_delta && script.update ? script.update : { success: true };
		}
		return { success: true, agent: AGENT };
	});
	return { calls, mock, backendFetch: mock as unknown as MissionControlDeps["backendFetch"] };
}

const updates = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/update")).map((c) => c.body ?? {});
const rebalances = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/rebalance")).map((c) => c.body);
const settle = (predicate: () => boolean) =>
	vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000 });

afterEach(() => {
	stopMissionControlRun(ID);
});

describe("rebalancing a run", () => {
	it("starts the same task again on the model the backend moved the agent to", async () => {
		const { calls, backendFetch } = backend({
			rebalance: { success: true, rebalance: { action: "escalate" }, agent: MOVED },
		});
		const runOneShotLLM = vi
			.fn<(options: OneShotLLMOptions) => Promise<string | null>>()
			.mockImplementationOnce(async (options) => {
				options.onFailure?.("HTTP 500 from the model");
				return null;
			})
			.mockResolvedValueOnce("FIXED");

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "fix the bug");

		await settle(() => updates(calls).some((u) => u.status === "completed"));
		expect(rebalances(calls)).toEqual([
			{ error: "HTTP 500 from the model", rate_limited: false, alternate_profile: false },
		]);
		const restart = calls.filter((c) => c.path.endsWith("/start")).at(-1);
		expect(restart?.body).toEqual({ task: "fix the bug", rebalanced: true });
		const second = runOneShotLLM.mock.calls[1][0];
		expect([second.provider, second.model, second.prompt]).toEqual(["openai", "gpt-standard", "fix the bug"]);
		// The first run's failure is never recorded: the agent went on.
		expect(updates(calls).some((u) => u.status === "error")).toBe(false);
		expect(isRunning(ID)).toBe(false);
	});

	it("records the failure when the backend does not move the agent", async () => {
		for (const rebalance of [
			{ success: true, rebalance: { action: "none" }, agent: AGENT },
			{ success: true, agent: AGENT },
			{ success: true, rebalance: { action: "reroute" } },
			{ success: false, error: "down" },
		]) {
			const { calls, backendFetch } = backend({ rebalance });
			const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => null);

			await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");

			await settle(() => updates(calls).some((u) => u.status === "error"));
			expect(updates(calls).at(-1)).toEqual({ status: "error", error: "No response from the provider" });
			expect(runOneShotLLM).toHaveBeenCalledTimes(1);
		}
	});

	it("records why a restart was refused", async () => {
		const { calls, backendFetch } = backend({
			rebalance: { success: true, rebalance: { action: "escalate" }, agent: MOVED },
			restart: { success: false, error: "Agent not found" },
		});
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => null);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");

		await settle(() => updates(calls).some((u) => u.status === "error"));
		expect(updates(calls).at(-1)).toEqual({ status: "error", error: "Agent not found" });
		expect(runOneShotLLM).toHaveBeenCalledTimes(1);
	});

	it("stops a looping answer, then hands it to the backend", async () => {
		const { calls, backendFetch } = backend({
			update: { success: true, agent: { loop_detected: true } },
			rebalance: { success: true, rebalance: { action: "none" }, agent: AGENT },
		});
		const runOneShotLLM = vi.fn(
			(options: OneShotLLMOptions) =>
				new Promise<string | null>((resolve) => {
					options.onDelta?.("again and again ");
					options.onUsage?.({ inputTokens: 5, outputTokens: 50, costUsd: 0.002 });
					options.signal?.addEventListener("abort", () => {
						options.onFailure?.("Stopped");
						// A client may still hand back what it had.
						resolve("again and again again");
					});
				}),
		);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");

		await settle(() => updates(calls).some((u) => u.status === "error"));
		expect(rebalances(calls)[0]?.error).toBe("The answer kept repeating itself");
		const sent = updates(calls);
		expect(sent).toContainEqual({ input_tokens: 5, output_tokens: 50, cost_usd: 0.002 });
		expect(sent.at(-1)).toEqual({ status: "error", error: "The answer kept repeating itself" });
		expect(sent.some((u) => u.status === "completed")).toBe(false);
	});

	it("tells the backend a Claude rate limit and whether another profile can take it", async () => {
		const { calls, backendFetch } = backend({});
		let seen: OneShotLLMOptions | undefined;
		const runOneShotLLM = vi.fn(async (options: OneShotLLMOptions) => {
			seen = options;
			options.onRateLimit?.({
				source: "other",
				profileId: "p1",
				suggestedProfile: { id: "p2", name: "Work" },
				detectedAt: new Date(),
			});
			return null;
		});

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");

		await settle(() => rebalances(calls).length === 1);
		expect(seen?.rateLimitSource).toBe("other");
		expect(rebalances(calls)[0]).toMatchObject({ rate_limited: true, alternate_profile: true });
	});

	it("reads no Claude rate limit on another provider", async () => {
		const { calls, mock, backendFetch } = backend({});
		mock.mockImplementation(async (path: string, init?: RequestInit) => {
			calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			return path.endsWith(ID) ? { success: true, agent: MOVED } : { success: true };
		});
		let seen: OneShotLLMOptions | undefined;
		const runOneShotLLM = vi.fn(async (options: OneShotLLMOptions) => {
			seen = options;
			return null;
		});

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");

		await settle(() => rebalances(calls).length === 1);
		expect(seen?.rateLimitSource).toBeUndefined();
		expect(seen?.onRateLimit).toBeUndefined();
		expect(rebalances(calls)[0]).toMatchObject({ rate_limited: false, alternate_profile: false });
	});

	it("does not restart an agent stopped while the backend decided", async () => {
		let release: (reply: Reply) => void = () => undefined;
		const { calls, mock, backendFetch } = backend({});
		const original = mock.getMockImplementation();
		mock.mockImplementation(async (path: string, init?: RequestInit) => {
			if (path.endsWith("/rebalance")) {
				calls.push({ path });
				return new Promise<Reply>((resolve) => {
					release = resolve;
				});
			}
			return original?.(path, init);
		});
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions) => null);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");
		await settle(() => rebalances(calls).length === 1);
		stopMissionControlRun(ID);
		release({ success: true, rebalance: { action: "escalate" }, agent: MOVED });

		await settle(() => updates(calls).some((u) => u.status === "error"));
		expect(runOneShotLLM).toHaveBeenCalledTimes(1);
		expect(calls.filter((c) => c.path.endsWith("/start"))).toHaveLength(1);
	});

	it("ignores a loop the backend reports once the run is stopped", async () => {
		const { calls, backendFetch } = backend({
			update: { success: true, agent: { loop_detected: true } },
		});
		let started = false;
		const runOneShotLLM = vi.fn(
			(options: OneShotLLMOptions) =>
				new Promise<string | null>((resolve) => {
					started = true;
					options.signal?.addEventListener("abort", () => resolve(null));
					// The person stops the run before its first chunk is sent.
					stopMissionControlRun(ID);
					options.onDelta?.("late chunk");
				}),
		);

		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");
		await settle(() => started);
		await new Promise((r) => setTimeout(r, 600));
		expect(rebalances(calls)).toEqual([]);
		expect(updates(calls).some((u) => "status" in u)).toBe(false);
	});

	it("records a runner that threw, unless the run was stopped", async () => {
		const { calls, backendFetch } = backend({});
		const runOneShotLLM = vi.fn(async (_options: OneShotLLMOptions): Promise<string | null> => {
			throw new Error("runner crashed");
		});
		await startMissionControlAgent({ backendFetch, runOneShotLLM }, ID, "x");
		await settle(() => updates(calls).some((u) => u.status === "error"));
		expect(updates(calls).at(-1)).toEqual({ status: "error", error: "runner crashed" });

		const stoppedRun = backend({});
		const throwsAfterStop = vi.fn(async (_options: OneShotLLMOptions): Promise<string | null> => {
			stopMissionControlRun(ID);
			throw "gone";
		});
		await startMissionControlAgent(
			{ backendFetch: stoppedRun.backendFetch, runOneShotLLM: throwsAfterStop },
			ID,
			"x",
		);
		await settle(() => throwsAfterStop.mock.calls.length === 1);
		await new Promise((r) => setTimeout(r, 50));
		expect(updates(stoppedRun.calls).some((u) => "status" in u)).toBe(false);
	});
});
