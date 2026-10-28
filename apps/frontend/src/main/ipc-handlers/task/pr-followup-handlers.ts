/**
 * PR follow-through IPC handlers.
 *
 * Once a task has its pull request, the card can keep driving it: the main
 * process spawns `runners/pr_followup_runner.py` for the task, which reads the
 * PR, runs the QA fixer on a red check or an unresolved review thread, checks
 * the fix commit and pushes it (never forced). The runner prints one JSON line
 * per look at the PR; each one is forwarded to the renderer.
 *
 * The renderer only names the task. The PR URL, the spec directory and the
 * worktree are read here from the task record, and the runner resolves them
 * again before use (docs/rules/security.md, S4 and S6). The runner gets the
 * task's own providers (`taskProviders`): the fix runs on the task's engine.
 *
 * Channels:
 *   invoke TASK_PR_FOLLOWUP_START  (taskId, options?) → IPCResult<PrFollowupStatus>
 *   invoke TASK_PR_FOLLOWUP_STOP   (taskId)           → IPCResult<PrFollowupStatus>
 *   invoke TASK_PR_FOLLOWUP_STATUS (taskId)           → IPCResult<PrFollowupStatus>
 *   send   TASK_PR_FOLLOWUP_EVENT  (taskId, PrFollowupStatus)
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { app, type BrowserWindow, ipcMain } from "electron";
import { getSpecsDir, IPC_CHANNELS } from "../../../shared/constants";
import type {
	IPCResult,
	PrFollowupRound,
	PrFollowupStartOptions,
	PrFollowupStatus,
} from "../../../shared/types";
import {
	planTaskProviders,
	readTaskMetadataFor,
	taskEngineFromMetadata,
} from "../../agent/task-provider-env";
import { appLog } from "../../app-logger";
import { parsePythonCommand } from "../../python-detector";
import { pythonEnvManager } from "../../python-env-manager";
import { pythonRunnerEnv } from "../../utils/python-runner-env";
import { findTaskWorktree } from "../../worktree-paths";
import { findTaskAndProject } from "./shared";

const RUNNER = "pr_followup_runner.py";
const DEFAULT_MAX_ROUNDS = 3;
const MAX_ROUNDS_CAP = 10;

interface FollowupRun {
	child: ChildProcess;
	round?: PrFollowupRound;
}

const runs = new Map<string, FollowupRun>();
const lastSeen = new Map<string, PrFollowupStatus>();

/** Options from the renderer, reduced to what the runner accepts. */
export function sanitizeFollowupOptions(raw: unknown): Required<PrFollowupStartOptions> {
	const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const rounds = Number(options.maxRounds);
	return {
		maxRounds:
			Number.isInteger(rounds) && rounds >= 0
				? Math.min(rounds, MAX_ROUNDS_CAP)
				: DEFAULT_MAX_ROUNDS,
		fixReviewThreads: options.fixReviewThreads !== false,
	};
}

export function buildFollowupArgs(input: {
	runnerPath: string;
	projectPath: string;
	specDir: string;
	specId: string;
	worktreePath: string;
	prUrl: string;
	options: Required<PrFollowupStartOptions>;
}): string[] {
	const args = [
		input.runnerPath,
		"--project-dir",
		input.projectPath,
		"--spec-dir",
		input.specDir,
		"--spec-name",
		input.specId,
		"--worktree-dir",
		input.worktreePath,
		"--pr-url",
		input.prUrl,
		"--max-rounds",
		String(input.options.maxRounds),
	];
	if (!input.options.fixReviewThreads) args.push("--no-review-threads");
	return args;
}

/** One stdout line of the runner, as a status update; null when it is not one. */
export function parseFollowupLine(
	line: string,
): { round?: PrFollowupRound; error?: string; final?: boolean } | null {
	const text = line.trim();
	if (!text.startsWith("{")) return null;
	try {
		const payload = JSON.parse(text) as Record<string, unknown>;
		if (typeof payload.error === "string") return { error: payload.error };
		if (payload.event === "round" && isRound(payload.round)) {
			return { round: payload.round };
		}
		if (isRound(payload.result)) return { round: payload.result, final: true };
	} catch {
		// A line of the fixer's own output, not ours.
	}
	return null;
}

function isRound(value: unknown): value is PrFollowupRound {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as PrFollowupRound).decision === "string" &&
		typeof (value as PrFollowupRound).action === "string"
	);
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

function status(taskId: string): PrFollowupStatus {
	const run = runs.get(taskId);
	if (run) return { running: true, round: run.round };
	return lastSeen.get(taskId) ?? { running: false };
}

export function registerPrFollowupHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	const publish = (taskId: string, value: PrFollowupStatus) => {
		getMainWindow()?.webContents.send(
			IPC_CHANNELS.TASK_PR_FOLLOWUP_EVENT,
			taskId,
			value,
		);
	};

	ipcMain.handle(
		IPC_CHANNELS.TASK_PR_FOLLOWUP_START,
		async (
			_,
			taskId: unknown,
			rawOptions?: unknown,
		): Promise<IPCResult<PrFollowupStatus>> => {
			if (typeof taskId !== "string" || !taskId) {
				return { success: false, error: "taskId is required" };
			}
			if (runs.has(taskId)) return { success: true, data: status(taskId) };

			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) return { success: false, error: "Task not found" };
			const prUrl = task.prUrl ?? task.metadata?.prUrl;
			if (!prUrl) return { success: false, error: "This task has no pull request" };
			const worktreePath = findTaskWorktree(project.path, task.specId);
			if (!worktreePath) {
				return { success: false, error: "The task's worktree no longer exists" };
			}
			const pythonPath = pythonEnvManager.getPythonPath();
			if (!pythonPath) return { success: false, error: "Python environment not ready" };

			const specDir = path.join(
				project.path,
				getSpecsDir(project.autoBuildPath || undefined),
				task.specId,
			);
			const engine = taskEngineFromMetadata(
				readTaskMetadataFor({ projectPath: project.path, specDir }),
			);
			const backend = backendPath();
			const env = await pythonRunnerEnv(backend, {
				taskProviders: planTaskProviders(engine, "qa"),
			});
			const [command, baseArgs] = parsePythonCommand(pythonPath);
			const args = buildFollowupArgs({
				runnerPath: path.join(backend, "runners", RUNNER),
				projectPath: project.path,
				specDir,
				specId: task.specId,
				worktreePath,
				prUrl,
				options: sanitizeFollowupOptions(rawOptions),
			});

			let child: ChildProcess;
			try {
				child = spawn(command, [...baseArgs, ...args], { cwd: backend, env });
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Failed to start",
				};
			}
			const run: FollowupRun = { child };
			runs.set(taskId, run);
			lastSeen.delete(taskId);
			publish(taskId, { running: true });

			let buffer = "";
			let error: string | undefined;
			child.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const parsed = parseFollowupLine(line);
					if (!parsed) continue;
					if (parsed.error) error = parsed.error;
					if (parsed.round) {
						run.round = parsed.round;
						publish(taskId, { running: !parsed.final, round: parsed.round });
					}
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				appLog.debug("[PR_FOLLOWUP]", chunk.toString().trim());
			});
			const finish = (code: number | null) => {
				if (runs.get(taskId)?.child !== child) return;
				runs.delete(taskId);
				const final: PrFollowupStatus = {
					running: false,
					round: run.round,
					error:
						error ??
						(code !== 0 && !run.round
							? `The follow-through stopped (exit ${code})`
							: undefined),
				};
				lastSeen.set(taskId, final);
				publish(taskId, final);
			};
			child.on("close", finish);
			child.on("error", (err) => {
				error = err.message;
				finish(-1);
			});
			return { success: true, data: status(taskId) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_PR_FOLLOWUP_STOP,
		async (_, taskId: unknown): Promise<IPCResult<PrFollowupStatus>> => {
			if (typeof taskId !== "string" || !taskId) {
				return { success: false, error: "taskId is required" };
			}
			runs.get(taskId)?.child.kill();
			return { success: true, data: status(taskId) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_PR_FOLLOWUP_STATUS,
		async (_, taskId: unknown): Promise<IPCResult<PrFollowupStatus>> => {
			if (typeof taskId !== "string" || !taskId) {
				return { success: false, error: "taskId is required" };
			}
			return { success: true, data: status(taskId) };
		},
	);
}

/** Stop every follow-through, when the app quits. */
export function stopAllPrFollowups(): void {
	for (const run of runs.values()) run.child.kill();
	runs.clear();
}
