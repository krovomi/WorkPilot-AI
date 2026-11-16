/**
 * A task's snapshots: list them, put the worktree back on one.
 *
 * Before each agent session the backend takes a git snapshot of the task's
 * worktree (`apps/backend/agent_snapshots/`); the session watch restores one
 * by itself when it stops a session (docs/architecture/agent-safety.md). This
 * is the person's way to do the same from the card.
 *
 * The renderer names a task and, to restore, a snapshot id. The task must be
 * a local task of a registered project; the id must have the backend's shape;
 * no agent may be running on the task, since a restore rewrites its files.
 * The runner (`runners/snapshot_runner.py`) checks the task name and the id
 * again and only ever works in the task's own worktree, never the project's
 * main checkout. A server card's worktree is on the server: refused here.
 *
 * Channels:
 *   invoke TASK_SNAPSHOTS_LIST   (taskId)             → IPCResult<TaskSnapshot[]>
 *   invoke TASK_SNAPSHOT_RESTORE (taskId, snapshotId) → IPCResult<TaskSnapshotRestore>
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, TaskSnapshot, TaskSnapshotRestore } from "../../../shared/types";
import { SNAPSHOT_ID } from "../../../shared/utils/agent-safety";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { parsePythonCommand } from "../../python-detector";
import { findServerCard } from "../../server-board-actions";
import { readyPythonPath } from "../../utils/ensure-python";
import { pythonRunnerEnv } from "../../utils/python-runner-env";
import { findTaskAndProject } from "./shared";

const RUNNER = "snapshot_runner.py";
/** A task folder name as the backend accepts one (`valid_task_name`). */
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const RUNNER_TIMEOUT_MS = 5 * 60_000;

type RunnerOutput = Record<string, unknown>;

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** The last JSON object the runner printed. */
export function parseSnapshotOutput(stdout: string): RunnerOutput {
	const lines = stdout.trim().split(/\r?\n/).reverse();
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// Not the result line.
		}
	}
	return { error: "The snapshot runner gave no answer" };
}

async function runSnapshotRunner(args: string[]): Promise<RunnerOutput> {
	const pythonPath = await readyPythonPath();
	if (!pythonPath) return { error: "Python environment not ready" };
	const backend = backendPath();
	const env = await pythonRunnerEnv(backend);
	const [exe, baseArgs] = parsePythonCommand(pythonPath);
	return new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exe, [...baseArgs, path.join(backend, "runners", RUNNER), ...args], {
				cwd: backend,
				env,
			});
		} catch (error) {
			resolve({ error: error instanceof Error ? error.message : "Failed to start" });
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			resolve({ error: "The snapshot runner timed out" });
		}, RUNNER_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appLog.debug("[SNAPSHOTS]", chunk.toString().trim());
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ error: err.message });
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(parseSnapshotOutput(stdout));
		});
	});
}

type Located = { projectPath: string; taskName: string } | { error: string };

function locate(taskId: unknown): Located {
	if (typeof taskId !== "string" || !taskId) return { error: "Invalid task" };
	if (findServerCard(taskId)) {
		return { error: "This card runs on the server: its snapshots are there" };
	}
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return { error: "Task not found" };
	if (!TASK_NAME.test(task.specId) || task.specId.includes("..")) {
		return { error: "Invalid task" };
	}
	return { projectPath: project.path, taskName: task.specId };
}

function isSnapshot(value: unknown): value is TaskSnapshot {
	if (!value || typeof value !== "object") return false;
	const s = value as Record<string, unknown>;
	return (
		typeof s.snapshot_id === "string" &&
		SNAPSHOT_ID.test(s.snapshot_id) &&
		typeof s.commit === "string" &&
		typeof s.head === "string" &&
		typeof s.created_at === "string" &&
		typeof s.label === "string"
	);
}

export async function listTaskSnapshots(taskId: unknown): Promise<IPCResult<TaskSnapshot[]>> {
	const located = locate(taskId);
	if ("error" in located) return { success: false, error: located.error };
	const out = await runSnapshotRunner([
		"list",
		"--project-dir",
		located.projectPath,
		"--task",
		located.taskName,
	]);
	if (typeof out.error === "string") return { success: false, error: out.error };
	const snapshots = Array.isArray(out.snapshots) ? out.snapshots.filter(isSnapshot) : [];
	return { success: true, data: snapshots };
}

export async function restoreTaskSnapshot(
	agentManager: Pick<AgentManager, "isRunning">,
	taskId: unknown,
	snapshotId: unknown,
): Promise<IPCResult<TaskSnapshotRestore>> {
	if (typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId)) {
		return { success: false, error: "Invalid snapshot" };
	}
	const located = locate(taskId);
	if ("error" in located) return { success: false, error: located.error };
	if (agentManager.isRunning(taskId as string)) {
		return { success: false, error: "Stop the task before restoring a snapshot" };
	}
	const out = await runSnapshotRunner([
		"rollback",
		"--project-dir",
		located.projectPath,
		"--task",
		located.taskName,
		"--snapshot",
		snapshotId,
	]);
	if (typeof out.error === "string") return { success: false, error: out.error };
	if (typeof out.restored !== "string" || typeof out.safety !== "string") {
		return { success: false, error: "The snapshot runner gave no answer" };
	}
	appLog.info(`[SNAPSHOTS] ${located.taskName}: restored ${out.restored}, previous state in ${out.safety}`);
	return { success: true, data: { restored: out.restored, safety: out.safety } };
}

export function registerSnapshotHandlers(agentManager: AgentManager): void {
	ipcMain.handle(IPC_CHANNELS.TASK_SNAPSHOTS_LIST, (_event, taskId: unknown) =>
		listTaskSnapshots(taskId),
	);
	ipcMain.handle(
		IPC_CHANNELS.TASK_SNAPSHOT_RESTORE,
		(_event, taskId: unknown, snapshotId: unknown) =>
			restoreTaskSnapshot(agentManager, taskId, snapshotId),
	);
}
