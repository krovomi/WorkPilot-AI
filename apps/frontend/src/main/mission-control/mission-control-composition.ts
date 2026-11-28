/**
 * Mission Control auto-compose (#344): a crew suggested from a description,
 * a spec or a template, on the providers the person picked, within a budget.
 *
 * The backend decides (`apps/backend/mission_control/composition.py`); this
 * module checks what the renderer sent, turns a project id into the project's
 * folder (the renderer never names a folder), and runs the optional second
 * opinion of a fast model. The backend holds no provider credentials, so it
 * only writes that request; the call runs here through `runOneShotLLM`, with
 * the first provider's own credentials and `requireProvider`, and its answer
 * goes back to the backend, which keeps only values of closed lists.
 *
 * Every refusal is a code the page translates.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IPCResult } from "../../shared/types";
import {
	MISSION_CONTROL_TEMPLATES,
	type MissionControlComposition,
} from "../../shared/types/mission-control";
import { logger } from "../app-logger";
import type { MissionControlDeps } from "./mission-control-runs";

const ROUTE = "/api/mission-control/composition";
export const MAX_PROMPT_CHARS = 20_000;
export const MAX_PROVIDERS = 8;
/** What the backend keeps of the model's answer. */
export const MAX_HINTS_CHARS = 8_000;
export const REFINE_TIMEOUT_MS = 90_000;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** A spec directory name, never a path. */
const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface CompositionDeps extends MissionControlDeps {
	/** The folder of a registered project, or undefined. */
	projectPath: (projectId: string) => string | undefined;
}

interface Refinement {
	provider: string;
	model: string;
	system_prompt: string;
	prompt: string;
}

type BackendComposition = MissionControlComposition & {
	refinement?: Refinement | null;
};

type Parsed =
	| { ok: true; body: Record<string, unknown>; projectDir?: string }
	| { ok: false; error: string };

export const isPositive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

/** A provider's name as the registry writes it, never a path or a command. */
export const isProviderName = (value: unknown): value is string =>
	typeof value === "string" && PROVIDER.test(value);

/** Check every field the renderer sent; build the backend's body. */
export function parseCompositionRequest(
	request: unknown,
	projectPath: CompositionDeps["projectPath"],
): Parsed {
	if (!request || typeof request !== "object") {
		return { ok: false, error: "invalid_request" };
	}
	const r = request as Record<string, unknown>;
	const prompt = r.prompt ?? "";
	if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_CHARS) {
		return { ok: false, error: "invalid_request" };
	}
	const providers = r.providers;
	if (
		!Array.isArray(providers) ||
		providers.length === 0 ||
		providers.length > MAX_PROVIDERS ||
		!providers.every(isProviderName)
	) {
		return { ok: false, error: "invalid_providers" };
	}
	const template = r.template;
	if (
		template !== undefined &&
		!(MISSION_CONTROL_TEMPLATES as readonly unknown[]).includes(template)
	) {
		return { ok: false, error: "unknown_template" };
	}
	const { budgetUsd, budgetTokens } = r;
	if (
		(budgetUsd !== undefined && !isPositive(budgetUsd)) ||
		(budgetTokens !== undefined &&
			!(isPositive(budgetTokens) && Number.isInteger(budgetTokens)))
	) {
		return { ok: false, error: "invalid_budget" };
	}
	let projectDir: string | undefined;
	if (r.projectId !== undefined) {
		projectDir =
			typeof r.projectId === "string" && r.projectId
				? projectPath(r.projectId)
				: undefined;
		if (!projectDir) return { ok: false, error: "invalid_project" };
	}
	const specId = r.specId;
	if (
		specId !== undefined &&
		(!projectDir || typeof specId !== "string" || !SPEC_ID.test(specId))
	) {
		return { ok: false, error: "invalid_spec" };
	}
	return {
		ok: true,
		projectDir,
		body: {
			prompt,
			providers,
			template,
			budget_usd: budgetUsd,
			budget_tokens: budgetTokens,
			project_dir: projectDir,
			spec_id: specId,
			refine: r.refine === true,
		},
	};
}

/** The fast model's answer, or null when it gave none. */
async function askModel(
	deps: CompositionDeps,
	refinement: Refinement,
	projectDir: string | undefined,
): Promise<string | null> {
	// A CLI provider is driven by its agent client, which wants a spec
	// directory: a throwaway one, so nothing lands in the project.
	const specDir = projectDir
		? mkdtempSync(path.join(tmpdir(), "wp-mission-compose-"))
		: undefined;
	try {
		return await deps.runOneShotLLM({
			prompt: refinement.prompt,
			systemPrompt: refinement.system_prompt,
			provider: refinement.provider,
			model: refinement.model || undefined,
			requireProvider: true,
			projectDir,
			specDir,
			timeoutMs: REFINE_TIMEOUT_MS,
			debugLabel: "MissionControl compose",
		});
	} catch (error) {
		logger.warn("[MissionControl] The composition model failed:", error);
		return null;
	} finally {
		if (specDir) rmSync(specDir, { recursive: true, force: true });
	}
}

function post(body: unknown): RequestInit {
	return { method: "POST", body: JSON.stringify(body) };
}

export async function suggestComposition(
	deps: CompositionDeps,
	request: unknown,
): Promise<IPCResult<MissionControlComposition>> {
	const parsed = parseCompositionRequest(request, deps.projectPath);
	if (!parsed.ok) return { success: false, error: parsed.error };

	const first = await deps.backendFetch<{ composition: BackendComposition }>(
		ROUTE,
		post(parsed.body),
	);
	if (!first.success) return { success: false, error: first.error };
	const { refinement, ...composition } = first.composition;
	if (!refinement) return { success: true, data: composition };

	const answer = await askModel(deps, refinement, parsed.projectDir);
	if (answer) {
		const second = await deps.backendFetch<{ composition: BackendComposition }>(
			ROUTE,
			post({
				...parsed.body,
				refine: false,
				model_hints: answer.slice(0, MAX_HINTS_CHARS),
			}),
		);
		if (second.success) {
			const { refinement: _none, ...refined } = second.composition;
			return { success: true, data: refined };
		}
	}
	// The heuristics stand; the page says the second opinion did not come.
	composition.warnings = [
		...composition.warnings,
		{ code: "refine_failed", params: { provider: refinement.provider } },
	];
	return { success: true, data: composition };
}
