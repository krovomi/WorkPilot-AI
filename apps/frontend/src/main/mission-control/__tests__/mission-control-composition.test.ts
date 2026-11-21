/**
 * Auto-compose in the main process: every field the renderer sends is
 * checked, a project id becomes its folder here, and the fast model's second
 * opinion runs on the first provider with its own credentials.
 */
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../app-logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { OneShotLLMOptions } from "../../oneshot-llm";
import {
	type CompositionDeps,
	MAX_HINTS_CHARS,
	MAX_PROMPT_CHARS,
	parseCompositionRequest,
	suggestComposition,
} from "../mission-control-composition";

const projects: Record<string, string> = { p1: "/home/me/proj" };
const projectPath = (id: string) => projects[id];

const COMPOSITION = { status: "ok", template: "bug_fix", warnings: [] };

function deps(
	responses: unknown[],
	answer: string | null | Error = null,
): CompositionDeps & { bodies: Record<string, unknown>[]; calls: OneShotLLMOptions[] } {
	const bodies: Record<string, unknown>[] = [];
	const calls: OneShotLLMOptions[] = [];
	return {
		bodies,
		calls,
		projectPath,
		backendFetch: vi.fn(async (_path: string, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return responses.shift();
		}) as unknown as CompositionDeps["backendFetch"],
		runOneShotLLM: vi.fn(async (options: OneShotLLMOptions) => {
			calls.push(options);
			if (options.specDir) expect(existsSync(options.specDir)).toBe(true);
			if (answer instanceof Error) throw answer;
			return answer;
		}),
	};
}

describe("parseCompositionRequest", () => {
	it("builds the backend body, with the project's folder", () => {
		const parsed = parseCompositionRequest(
			{
				prompt: "Fix login",
				providers: ["anthropic", "gemini-cli"],
				template: "bug_fix",
				budgetUsd: 2.5,
				budgetTokens: 100_000,
				projectId: "p1",
				specId: "001-login",
				refine: true,
			},
			projectPath,
		);
		expect(parsed).toEqual({
			ok: true,
			projectDir: "/home/me/proj",
			body: {
				prompt: "Fix login",
				providers: ["anthropic", "gemini-cli"],
				template: "bug_fix",
				budget_usd: 2.5,
				budget_tokens: 100_000,
				project_dir: "/home/me/proj",
				spec_id: "001-login",
				refine: true,
			},
		});
	});

	it("needs only providers", () => {
		const parsed = parseCompositionRequest({ providers: ["ollama"] }, projectPath);
		expect(parsed).toMatchObject({ ok: true, body: { prompt: "", refine: false } });
	});

	it.each([
		[null, "invalid_request"],
		["text", "invalid_request"],
		[{ providers: ["a"], prompt: 3 }, "invalid_request"],
		[{ providers: ["a"], prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }, "invalid_request"],
		[{}, "invalid_providers"],
		[{ providers: [] }, "invalid_providers"],
		[{ providers: Array(9).fill("a") }, "invalid_providers"],
		[{ providers: ["../evil"] }, "invalid_providers"],
		[{ providers: [7] }, "invalid_providers"],
		[{ providers: ["a"], template: "launch" }, "unknown_template"],
		[{ providers: ["a"], budgetUsd: 0 }, "invalid_budget"],
		[{ providers: ["a"], budgetUsd: "5" }, "invalid_budget"],
		[{ providers: ["a"], budgetUsd: Number.POSITIVE_INFINITY }, "invalid_budget"],
		[{ providers: ["a"], budgetTokens: 1.5 }, "invalid_budget"],
		[{ providers: ["a"], budgetTokens: -1 }, "invalid_budget"],
		[{ providers: ["a"], projectId: "unknown" }, "invalid_project"],
		[{ providers: ["a"], projectId: "" }, "invalid_project"],
		[{ providers: ["a"], projectId: 4 }, "invalid_project"],
		[{ providers: ["a"], specId: "001" }, "invalid_spec"],
		[{ providers: ["a"], projectId: "p1", specId: "../../etc" }, "invalid_spec"],
		[{ providers: ["a"], projectId: "p1", specId: "/abs" }, "invalid_spec"],
		[{ providers: ["a"], projectId: "p1", specId: 12 }, "invalid_spec"],
	])("refuses %j with %s", (request, error) => {
		expect(parseCompositionRequest(request, projectPath)).toEqual({ ok: false, error });
	});
});

describe("suggestComposition", () => {
	it("refuses before reaching the backend", async () => {
		const d = deps([]);
		expect(await suggestComposition(d, { providers: [] })).toEqual({
			success: false,
			error: "invalid_providers",
		});
		expect(d.backendFetch).not.toHaveBeenCalled();
	});

	it("passes the backend's refusal on", async () => {
		const d = deps([{ success: false, error: "no_provider" }]);
		expect(await suggestComposition(d, { providers: ["meta"] })).toEqual({
			success: false,
			error: "no_provider",
		});
	});

	it("returns the composition without its refinement request", async () => {
		const d = deps([{ success: true, composition: { ...COMPOSITION, refinement: null } }]);
		const res = await suggestComposition(d, { providers: ["anthropic"] });
		expect(res).toEqual({ success: true, data: COMPOSITION });
		expect(d.runOneShotLLM).not.toHaveBeenCalled();
	});

	const refinement = {
		provider: "google",
		model: "",
		system_prompt: "You classify",
		prompt: "classify this",
	};

	it("asks the fast model and sends its answer back as hints", async () => {
		const refined = { ...COMPOSITION, template: "incident_response", refinement: null };
		const d = deps(
			[
				{ success: true, composition: { ...COMPOSITION, refinement } },
				{ success: true, composition: refined },
			],
			`{"kind":"incident_response"}${"x".repeat(MAX_HINTS_CHARS)}`,
		);
		const res = await suggestComposition(d, {
			providers: ["google"],
			projectId: "p1",
			refine: true,
		});
		expect(res).toEqual({
			success: true,
			data: { ...COMPOSITION, template: "incident_response" },
		});
		expect(d.calls[0]).toMatchObject({
			provider: "google",
			model: undefined,
			requireProvider: true,
			projectDir: "/home/me/proj",
			systemPrompt: "You classify",
		});
		// The throwaway spec directory is gone once the call is over.
		expect(existsSync(String(d.calls[0].specDir))).toBe(false);
		expect(d.bodies[1]).toMatchObject({ refine: false });
		expect(String(d.bodies[1].model_hints)).toHaveLength(MAX_HINTS_CHARS);
	});

	it.each([
		["no answer", null, []],
		["a failing call", new Error("boom"), []],
		["a failing second call", "{}", [{ success: false, error: "HTTP 500" }]],
	])("keeps the heuristics on %s and says so", async (_label, answer, more) => {
		const d = deps(
			[
				{
					success: true,
					composition: { ...COMPOSITION, refinement: { ...refinement, model: "m-fast" } },
				},
				...more,
			],
			answer as string | null | Error,
		);
		const res = await suggestComposition(d, { providers: ["google"], refine: true });
		expect(res).toEqual({
			success: true,
			data: {
				...COMPOSITION,
				warnings: [{ code: "refine_failed", params: { provider: "google" } }],
			},
		});
		expect(d.calls[0]).toMatchObject({ model: "m-fast", specDir: undefined });
	});
});
