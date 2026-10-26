/**
 * The environment of a backend Python runner launched by a view.
 *
 * A view runner (tech debt, doc drift, swarm, Jira import…) used to receive
 * `{ ...process.env, PYTHONPATH }`: every credential the main process happened
 * to carry, and none of those the user configured in the app, so a runner on
 * a page set to OpenAI still started on whatever `process.env` held.
 *
 * Built here instead, as `agent-process.ts` and `oneshot-llm.ts` build theirs
 * (docs/rules/security.md, S1 and S4: a secret only goes to the process that
 * needs it):
 *
 * 1. the main process env without any credential (`envWithoutCredentials`),
 *    with the tool paths of `getAugmentedEnv` and the Python env of
 *    `pythonEnvManager` (bundled site-packages, git variables isolated);
 * 2. the backend `.env`, decrypted (`loadBackendEnv`);
 * 3. the Claude profile token, or the active API profile and the clearing of
 *    stale `ANTHROPIC_*` variables in OAuth mode; none of them when the
 *    provider is neither Claude nor Copilot, as in `agent-process.ts`, so the
 *    Claude CLI does not sign in to Anthropic with another provider's models;
 * 4. the provider of the calling page, or the global one, and its key; for a
 *    runner that works on a Kanban task, the task's own providers instead
 *    (`taskProviders`, as `agent-process.ts` does for the build);
 * 5. `PYTHONPATH` with the backend first, the UTF-8 switches, then `extra`
 *    (a connector's own credentials, read by the caller from its settings).
 */
import path from "node:path";
import type { PageLlmPage } from "../../shared/utils/page-llm";
import {
	buildTaskProviderEnv,
	type TaskProviderPlan,
} from "../agent/task-provider-env";
import { getOAuthModeClearVars } from "../agent/env-utils";
import { getAugmentedEnv } from "../env-utils";
import { pythonEnvManager } from "../python-env-manager";
import { getBestAvailableProfileEnv } from "../rate-limit-detector";
import {
	getGlobalProviderEnv,
	getPageProviderEnv,
} from "../services/page-llm-config";
import { getAPIProfileEnv } from "../services/profile";
import { loadBackendEnv } from "../source-env";
import { envWithoutCredentials } from "./child-env";

export interface PythonRunnerEnvOptions {
	/** The page whose provider the runner uses; the global provider otherwise. */
	page?: PageLlmPage;
	/**
	 * The providers of the Kanban task the runner works on. When set, they
	 * replace the page's or the global provider: a task owns its engine.
	 */
	taskProviders?: TaskProviderPlan;
	/** Variables of this launch, applied last. */
	extra?: Record<string, string | undefined>;
}

async function apiProfileEnv(): Promise<Record<string, string>> {
	try {
		return await getAPIProfileEnv();
	} catch {
		return {};
	}
}

function backendEnv(backendPath: string): Record<string, string> {
	try {
		return loadBackendEnv(backendPath);
	} catch {
		return {};
	}
}

// Providers that run on Claude's sign-in (Copilot goes through its gh CLI).
const CLAUDE_AUTH_PROVIDERS: ReadonlySet<string> = new Set([
	"",
	"claude",
	"anthropic",
	"copilot",
]);

async function claudeAuthEnv(): Promise<Record<string, string>> {
	const profile = await apiProfileEnv();
	const usesApiProfile = Object.keys(profile).length > 0;
	return {
		...(usesApiProfile ? {} : getBestAvailableProfileEnv().env),
		...profile,
		...getOAuthModeClearVars(profile),
	};
}

function pythonPath(backendPath: string, bundled: string | undefined): string {
	const entries = [backendPath, ...(bundled ?? "").split(path.delimiter)]
		.map((entry) => entry.trim())
		.filter(Boolean);
	return [...new Set(entries)].join(path.delimiter);
}

export async function pythonRunnerEnv(
	backendPath: string,
	options: PythonRunnerEnvOptions = {},
): Promise<Record<string, string>> {
	const pythonEnv = pythonEnvManager.getPythonEnv();
	const plan = options.taskProviders;
	const providerEnv = plan
		? buildTaskProviderEnv(plan)
		: options.page
			? getPageProviderEnv(options.page)
			: getGlobalProviderEnv();
	const provider = (providerEnv.SELECTED_LLM_PROVIDER ?? "").toLowerCase();
	const needsClaudeAuth = plan
		? plan.usesClaude || plan.providers.includes("copilot")
		: CLAUDE_AUTH_PROVIDERS.has(provider);
	const authEnv = needsClaudeAuth ? await claudeAuthEnv() : {};

	return envWithoutCredentials(
		{ ...getAugmentedEnv(), ...pythonEnv },
		{
			...backendEnv(backendPath),
			...authEnv,
			...providerEnv,
			PYTHONPATH: pythonPath(backendPath, pythonEnv.PYTHONPATH),
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONUTF8: "1",
			...options.extra,
		},
	);
}
