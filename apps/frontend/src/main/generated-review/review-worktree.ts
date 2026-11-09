/**
 * The card's worktree, made and committed by the Kanban's own worktree code.
 *
 * `runners/review_worktree_runner.py` drives `core.worktree.WorktreeManager`,
 * the class the Kanban pipeline builds in: same `.workpilot/worktrees/tasks/
 * <spec>` folder, same `workpilot/<spec>` branch from the same base branch,
 * same exclusions at commit time (`.workpilot/`, build outputs). No model is
 * called, so the runner gets the static environment: no provider, no Claude
 * profile, no backend `.env` (docs/rules/security.md S1), and git variables
 * of an enclosing hook cleared so it never commits into another repository.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { parsePythonCommand } from "../python-detector";
import { getConfiguredPythonPath } from "../python-env-manager";
import { getEffectiveSourcePath } from "../updater/path-resolver";
import { getIsolatedGitEnv } from "../utils/git-isolation";
import { pythonStaticRunnerEnv } from "../utils/python-runner-env";

const RESULT_PREFIX = "__REVIEW_WORKTREE__:";
const ERROR_PREFIX = "__REVIEW_WORKTREE_ERROR__:";
/** `git fetch` of the base branch is the slow part; a minute is a hung remote. */
const TIMEOUT_MS = 120_000;

export interface CreatedWorktree {
	readonly path: string;
	readonly branch: string;
	readonly baseBranch: string;
}

export interface WorktreeCommit {
	readonly committed: boolean;
	readonly files: string[];
}

/** One runner call; rejects with the runner's own message. */
export type RunReviewWorktree = (args: string[]) => Promise<Record<string, unknown>>;

export const runReviewWorktree: RunReviewWorktree = (args) => {
	const backend = getEffectiveSourcePath();
	if (!backend) {
		return Promise.reject(new Error("WorkPilot AI backend not found"));
	}
	const runner = path.join(backend, "runners", "review_worktree_runner.py");
	const [command, baseArgs] = parsePythonCommand(getConfiguredPythonPath());
	return new Promise((resolve, reject) => {
		const proc = spawn(command, [...baseArgs, runner, ...args], {
			cwd: backend,
			env: getIsolatedGitEnv(pythonStaticRunnerEnv(backend)) as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error("The worktree could not be prepared in time"));
		}, TIMEOUT_MS);
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf-8")).slice(-4000);
		});
		proc.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		proc.on("close", () => {
			clearTimeout(timer);
			const lines = stdout.split(/\r?\n/);
			const error = lines.find((line) => line.startsWith(ERROR_PREFIX));
			if (error) {
				reject(new Error(error.slice(ERROR_PREFIX.length).trim()));
				return;
			}
			const result = lines.find((line) => line.startsWith(RESULT_PREFIX));
			if (!result) {
				reject(new Error(stderr.trim().split("\n").pop() || "The worktree runner said nothing"));
				return;
			}
			try {
				resolve(JSON.parse(result.slice(RESULT_PREFIX.length)));
			} catch {
				reject(new Error("The worktree runner answered something unreadable"));
			}
		});
	});
};

export async function createReviewWorktree(
	projectPath: string,
	specId: string,
	baseBranch: string | undefined,
	run: RunReviewWorktree = runReviewWorktree,
): Promise<CreatedWorktree> {
	const args = ["--action", "create", "--project-dir", projectPath, "--spec", specId];
	if (baseBranch) args.push("--base-branch", baseBranch);
	const out = await run(args);
	if (typeof out.path !== "string" || typeof out.branch !== "string") {
		throw new Error("The worktree runner gave no worktree");
	}
	return {
		path: out.path,
		branch: out.branch,
		baseBranch: typeof out.base_branch === "string" ? out.base_branch : baseBranch ?? "",
	};
}

export async function commitReviewWorktree(
	projectPath: string,
	specId: string,
	baseBranch: string | undefined,
	message: string,
	run: RunReviewWorktree = runReviewWorktree,
): Promise<WorktreeCommit> {
	const args = [
		"--action",
		"commit",
		"--project-dir",
		projectPath,
		"--spec",
		specId,
		"--message",
		message,
	];
	if (baseBranch) args.push("--base-branch", baseBranch);
	const out = await run(args);
	return {
		committed: out.committed === true,
		files: Array.isArray(out.files)
			? out.files.filter((f): f is string => typeof f === "string")
			: [],
	};
}
