/**
 * Mission Control runs: the model call behind an agent card.
 *
 * The backend (`apps/backend/mission_control/`) only keeps the state of each
 * agent. It runs inside the uvicorn process Electron starts once, with none of
 * the user's provider credentials or Claude profile, so it cannot call a model
 * itself: starting an agent used to mark it "running" and nothing ever ran.
 *
 * The call happens here instead, through `runOneShotLLM`, which hands the
 * runner the credentials of the agent's own provider. Every provider the
 * backend drives answers for itself; one with no adapter (meta, aws, cursor,
 * custom) fails with that reason rather than being answered by Claude under
 * its name (`requireProvider`). The CLIs (pi, OpenCode, Antigravity, Gemini
 * CLI) need a project: they run in the selected one, text only.
 *
 * What the model says is streamed back to the backend as `output_delta`, then
 * the provider's usage and the end of the run, so the card, the tree and the
 * event log read it on their next poll.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../app-logger";
import type { BackendResult } from "../ipc-handlers/_backend-fetch";
import type { OneShotLLMOptions, OneShotUsage } from "../oneshot-llm";

export const MAX_TASK_CHARS = 20_000;
/** A real agent turn can take minutes on a CLI provider; never forever. */
export const RUN_TIMEOUT_MS = 10 * 60_000;
/** Chunks are sent in batches: the page polls every 1.5 s anyway. */
const FLUSH_INTERVAL_MS = 400;
const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/;

/** What each role is asked to be. Written for the model, never shown. */
const ROLE_PROMPTS: Record<string, string> = {
	architect:
		"You are a software architect. Answer with the design: components, " +
		"their responsibilities and boundaries, and the trade-offs behind each choice.",
	coder:
		"You are a senior software engineer. Answer with the code the task asks " +
		"for and only the explanation a reader needs to use it.",
	tester:
		"You are a test engineer. Write the tests the task calls for, covering " +
		"the happy path and the edge cases that can actually break.",
	reviewer:
		"You are a code reviewer. Report what is wrong, ordered by severity, " +
		"each finding naming the failure it causes. Say plainly when something is fine.",
	documenter:
		"You are a technical writer. Write clear, accurate documentation for " +
		"the reader the task names.",
	planner:
		"You are a technical planner. Break the work into ordered, verifiable " +
		"steps. No time estimates.",
	debugger:
		"You are a debugging specialist. Find the most likely root cause, say " +
		"how to confirm it, then give the fix.",
	custom: "You are a helpful software engineering assistant.",
};

export function rolePrompt(role: string): string {
	return ROLE_PROMPTS[role] ?? ROLE_PROMPTS.custom;
}

export function isAgentId(value: unknown): value is string {
	return typeof value === "string" && AGENT_ID.test(value);
}

interface AgentConfig {
	provider: string;
	model: string;
	role: string;
	current_task: string;
}

export interface MissionControlDeps {
	backendFetch: <T>(
		path: string,
		init?: RequestInit,
	) => Promise<BackendResult<T>>;
	runOneShotLLM: (options: OneShotLLMOptions) => Promise<string | null>;
}

export type StartResult = { success: true } | { success: false; error: string };

const running = new Map<string, AbortController>();

function post(deps: MissionControlDeps, agentId: string, body: unknown) {
	return deps.backendFetch(`/api/mission-control/agents/${agentId}/update`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

/** Is a run of this agent in progress in this process? */
export function isRunning(agentId: string): boolean {
	return running.has(agentId);
}

/**
 * Start `agentId` on `task` (its last task when empty), in `projectDir` when
 * one is given. Resolves once the run has started; the run reports itself.
 */
export async function startMissionControlAgent(
	deps: MissionControlDeps,
	agentId: string,
	task: string,
	projectDir?: string,
): Promise<StartResult> {
	const found = await deps.backendFetch<{ agent: AgentConfig }>(
		`/api/mission-control/agents/${agentId}`,
	);
	if (!found.success) return { success: false, error: found.error };
	const agent = found.agent;
	const prompt = (task || agent.current_task || "").trim();
	if (!prompt) return { success: false, error: "A task is required" };
	if (!agent.provider) {
		return { success: false, error: "This agent has no provider" };
	}

	stopMissionControlRun(agentId);
	const started = await deps.backendFetch(
		`/api/mission-control/agents/${agentId}/start`,
		{ method: "POST", body: JSON.stringify({ task: prompt }) },
	);
	if (!started.success) return { success: false, error: started.error };

	const controller = new AbortController();
	running.set(agentId, controller);
	void runAgent(deps, agentId, agent, prompt, projectDir, controller);
	return { success: true };
}

async function runAgent(
	deps: MissionControlDeps,
	agentId: string,
	agent: AgentConfig,
	prompt: string,
	projectDir: string | undefined,
	controller: AbortController,
): Promise<void> {
	let pending = "";
	let streamed = false;
	let flushing: Promise<unknown> = Promise.resolve();
	const flush = () => {
		if (pending) {
			const chunk = pending;
			pending = "";
			flushing = flushing.then(() => post(deps, agentId, { output_delta: chunk }));
		}
		return flushing;
	};
	const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
	let failure: string | null = null;
	let usage: OneShotUsage | null = null;

	// A CLI provider is driven by its agent client, which wants a spec
	// directory: a throwaway one, so nothing lands in the project.
	let specDir: string | undefined;
	if (projectDir) {
		try {
			specDir = mkdtempSync(path.join(tmpdir(), "wp-mission-control-"));
		} catch (error) {
			logger.warn("[MissionControl] Could not create a spec directory:", error);
		}
	}

	try {
		const text = await deps.runOneShotLLM({
			prompt,
			systemPrompt: rolePrompt(agent.role),
			provider: agent.provider,
			model: agent.model || undefined,
			requireProvider: true,
			projectDir,
			specDir,
			timeoutMs: RUN_TIMEOUT_MS,
			signal: controller.signal,
			debugLabel: `MissionControl ${agentId}`,
			onDelta: (chunk) => {
				streamed = true;
				pending += chunk;
			},
			onUsage: (reported) => {
				usage = reported;
			},
			onFailure: (reason) => {
				failure = reason;
			},
		});
		clearInterval(timer);
		// Stopped from the card: the backend already recorded it.
		if (controller.signal.aborted) return;

		// A client that does not stream hands over the whole text at the end.
		if (text && !streamed) pending = text;
		await flush();
		const reported = usage as OneShotUsage | null;
		if (reported) {
			await post(deps, agentId, {
				input_tokens: reported.inputTokens,
				output_tokens: reported.outputTokens,
				cost_usd: reported.costUsd,
			});
		}
		await post(
			deps,
			agentId,
			text
				? { status: "completed", progress: 1 }
				: {
						status: "error",
						error: (failure || "No response from the provider").slice(0, 2_000),
					},
		);
	} catch (error) {
		logger.warn("[MissionControl] Run failed:", error);
		if (!controller.signal.aborted) {
			await post(deps, agentId, {
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	} finally {
		clearInterval(timer);
		if (running.get(agentId) === controller) running.delete(agentId);
		if (specDir) rmSync(specDir, { recursive: true, force: true });
	}
}

/** Kill the run of `agentId`, if any. The backend records the stop itself. */
export function stopMissionControlRun(agentId: string): boolean {
	const controller = running.get(agentId);
	if (!controller) return false;
	running.delete(agentId);
	controller.abort();
	return true;
}

/** Kill every run: the session was stopped, or the app is closing. */
export function stopAllMissionControlRuns(): void {
	for (const id of [...running.keys()]) stopMissionControlRun(id);
}
