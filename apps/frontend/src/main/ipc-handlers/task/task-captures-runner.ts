/**
 * `runners/pr_captures_runner.py` for the Captures tab: publish (review
 * mode), withdraw, or update the pull request's « Captures » section.
 *
 * The main process builds every argument: the action comes from a closed
 * list, the spec name and the base branch from the task as the store knows
 * it, the project folder from the registered project. The runner looks up the
 * pull request of the task's branch itself, so no URL from anywhere reaches
 * it. Its environment is the one the pull request was created with (forge
 * CLI paths, the project's forge identifiers), since it edits that PR.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type {
	TaskCapturesAction,
	TaskCapturesSync,
} from "../../../shared/types/task-captures";
import { TASK_CAPTURES_ACTIONS } from "../../../shared/types/task-captures";
import { getAppLanguage } from "../../app-language";
import { getToolPath } from "../../cli-tool-manager";
import { killProcessGracefully } from "../../platform";
import { parsePythonCommand } from "../../python-detector";
import {
	getConfiguredPythonPath,
	type PythonEnvManager,
	pythonEnvManager as pythonEnvManagerSingleton,
} from "../../python-env-manager";
import { getBestAvailableProfileEnv } from "../../rate-limit-detector";
import { getEffectiveSourcePath } from "../../updater/path-resolver";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import { GIT_BRANCH_REGEX } from "./worktree-git-refs";
import {
	initializePythonEnvForPR,
	loadProjectEnvForSubprocess,
} from "./worktree-pr-helpers";

/** Hosting a dozen images and editing the PR body: a few forge calls. */
export const CAPTURES_RUNNER_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 200_000;
/** The runner's own rule for a spec name (`_SPEC_NAME`). */
export const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isCapturesAction(value: unknown): value is TaskCapturesAction {
	return (
		typeof value === "string" &&
		(TASK_CAPTURES_ACTIONS as readonly string[]).includes(value)
	);
}

export interface CapturesRunnerArgs {
	action: TaskCapturesAction;
	projectPath: string;
	specId: string;
	targetBranch?: string;
}

/** The runner's argv after the script, or an error code. */
export function buildCapturesRunnerArgs(
	args: CapturesRunnerArgs,
): { argv: string[] } | { error: string } {
	if (!isCapturesAction(args.action)) return { error: "invalid-action" };
	if (!SPEC_NAME.test(args.specId)) return { error: "invalid-spec" };
	if (!path.isAbsolute(args.projectPath)) return { error: "invalid-project" };
	const argv = [
		args.action,
		"--project-dir",
		args.projectPath,
		"--spec-name",
		args.specId,
	];
	if (args.targetBranch) {
		if (!GIT_BRANCH_REGEX.test(args.targetBranch) || args.targetBranch.includes("..")) {
			return { error: "invalid-branch" };
		}
		argv.push("--target-branch", args.targetBranch);
	}
	return { argv };
}

/** The runner's last JSON line: `{"result": {...}}` or `{"error": "..."}`. */
export function parseCapturesRunnerOutput(
	stdout: string,
): { result?: Partial<TaskCapturesSync> & Record<string, unknown>; error?: string } | null {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
	for (const line of lines.reverse()) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.result && typeof parsed.result === "object") {
				return { result: parsed.result as Record<string, unknown> };
			}
			if (typeof parsed.error === "string") {
				return { error: parsed.error.slice(0, 300) };
			}
		} catch {
			// Not the runner's line: keep looking.
		}
	}
	return null;
}

export async function runCapturesRunner(
	pythonEnvManager: PythonEnvManager,
	project: { path: string; autoBuildPath?: string | null },
	args: CapturesRunnerArgs,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
	const built = buildCapturesRunnerArgs(args);
	if ("error" in built) return { ok: false, error: built.error };
	const envError = await initializePythonEnvForPR(pythonEnvManager);
	if (envError) return { ok: false, error: "python-not-ready" };
	const sourcePath = getEffectiveSourcePath();
	if (!sourcePath) return { ok: false, error: "backend-not-found" };
	const script = path.join(sourcePath, "runners", "pr_captures_runner.py");

	const [pythonCommand, pythonBaseArgs] = parsePythonCommand(getConfiguredPythonPath());
	const env = {
		...getIsolatedGitEnv(),
		...pythonEnvManagerSingleton.getPythonEnv(),
		...getBestAvailableProfileEnv().env,
		...loadProjectEnvForSubprocess(project),
		GITHUB_CLI_PATH: getToolPath("gh"),
		APP_LANGUAGE: getAppLanguage(),
		PYTHONUNBUFFERED: "1",
		PYTHONUTF8: "1",
	};

	return await new Promise((resolve) => {
		let settled = false;
		const finish = (
			value: { ok: true; result: Record<string, unknown> } | { ok: false; error: string },
		) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(pythonCommand, [...pythonBaseArgs, script, ...built.argv], {
				cwd: sourcePath,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			finish({ ok: false, error: "spawn-failed" });
			return;
		}
		const timer = setTimeout(() => {
			killProcessGracefully(child, { debugPrefix: "[TASK_CAPTURES]", debug: false });
			finish({ ok: false, error: "timeout" });
		}, CAPTURES_RUNNER_TIMEOUT_MS);
		let stdout = "";
		child.stdout?.on("data", (data: Buffer) => {
			if (stdout.length < MAX_OUTPUT) stdout += data.toString("utf-8");
		});
		child.on("error", () => {
			clearTimeout(timer);
			finish({ ok: false, error: "spawn-failed" });
		});
		child.on("close", () => {
			clearTimeout(timer);
			const parsed = parseCapturesRunnerOutput(stdout);
			if (parsed?.result) finish({ ok: true, result: parsed.result });
			else finish({ ok: false, error: parsed?.error ? "runner-refused" : "no-answer" });
		});
	});
}
