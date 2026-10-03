import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getSpecsDir } from "../../shared/constants";
import type { TaskMetadata } from "../../shared/types";
import {
	defaultEngineProvider,
	type EnginePhase,
	engineProviders,
	engineUsesClaude,
	isClaudeProvider,
	resolveTaskEngine,
	seedEngine,
	type EngineSeedSettings,
	type TaskEngine,
} from "../../shared/utils/task-engine";
import { appLog } from "../app-logger";
import { projectStore } from "../project-store";
import { credentialManager } from "../services/credential-manager";
import { readSettingsFile } from "../settings-utils";

/**
 * The environment of a Kanban task's subprocess comes from the task.
 *
 * A build used to inherit `SELECTED_LLM_PROVIDER` — and the credentials — of
 * whatever the header's "Fournisseur IA" list said at launch, so a task
 * configured for Ollama started on Copilot because somebody else's page had
 * been switched to it. The task now names its providers (`task-engine.ts`),
 * and this module turns that into an environment: the credentials of every
 * provider any of its phases uses, so a phase on OpenAI and the next on
 * Mistral both find their key, and `SELECTED_LLM_PROVIDER` set to the phase
 * the process starts in.
 *
 * Claude is never re-stated here: its OAuth / API-profile chain is resolved by
 * the process manager (`getBestAvailableProfileEnv`, `getAPIProfileEnv`), and
 * layering a key on top could contradict the mode it chose — the rule
 * `buildContestantEnv` already follows for the Bounty Board.
 */

export interface TaskProviderPlan {
	/** Every provider a phase of the task uses, each once. */
	providers: string[];
	/** The provider of the phase the process starts in. */
	startProvider: string;
	/** Whether any phase needs Claude credentials. */
	usesClaude: boolean;
}

/** The engine of a task read from its metadata, completed from Settings. */
export function taskEngineFromMetadata(
	metadata: TaskMetadata | undefined,
	settings: EngineSeedSettings | undefined = readSettingsFile() as
		| EngineSeedSettings
		| undefined,
	projectProvider?: string | null,
): TaskEngine {
	const fallbackProvider =
		metadata?.provider || defaultEngineProvider(settings, projectProvider);
	return resolveTaskEngine(metadata, seedEngine(settings, fallbackProvider));
}

export function planTaskProviders(
	engine: TaskEngine,
	startPhase: EnginePhase,
): TaskProviderPlan {
	return {
		providers: engineProviders(engine),
		startProvider: engine[startPhase].provider,
		usesClaude: engineUsesClaude(engine),
	};
}

/**
 * The provider part of the subprocess environment for `plan`.
 *
 * `getEnv` is the credential manager's lookup, injectable for tests. A
 * provider whose credentials cannot be read is skipped with a warning: that
 * phase then fails with the provider's own error, which says more than a
 * refusal to start the whole task.
 */
export function buildTaskProviderEnv(
	plan: TaskProviderPlan,
	getEnv: (provider: string) => Record<string, string> = (provider) =>
		credentialManager.getEnvironmentVariables(provider),
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const provider of plan.providers) {
		if (isClaudeProvider(provider)) continue;
		try {
			Object.assign(env, getEnv(provider));
		} catch (err) {
			appLog.warn(
				`[TaskProviderEnv] no credentials for provider "${provider}":`,
				(err as Error).message,
			);
		}
	}
	const start = plan.startProvider.trim().toLowerCase();
	env.SELECTED_LLM_PROVIDER = isClaudeProvider(start) ? "claude" : start;
	return env;
}

/**
 * The task_metadata.json of a task, read where the backend will read it.
 *
 * `specDir` when the caller has one; otherwise the project's specs directory,
 * whose name comes from the project record (`autoBuildPath`).
 */
export function readTaskMetadataFor(location: {
	projectPath: string;
	specId?: string;
	specDir?: string;
}): TaskMetadata | undefined {
	const candidates: string[] = [];
	if (location.specDir) candidates.push(location.specDir);
	if (location.specId) {
		const project = projectStore
			.getProjects()
			.find((p) => p.path === location.projectPath);
		candidates.push(
			path.join(
				location.projectPath,
				getSpecsDir(project?.autoBuildPath || undefined),
				location.specId,
			),
		);
	}
	for (const dir of candidates) {
		const file = path.join(dir, "task_metadata.json");
		if (!existsSync(file)) continue;
		try {
			return JSON.parse(readFileSync(file, "utf-8")) as TaskMetadata;
		} catch (err) {
			appLog.warn(
				`[TaskProviderEnv] unreadable ${file}:`,
				(err as Error).message,
			);
		}
	}
	return undefined;
}
