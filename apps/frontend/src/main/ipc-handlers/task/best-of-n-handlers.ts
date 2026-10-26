/**
 * Best-of-N IPC handlers.
 *
 * One task, built N ways (2 to 4): each variant is a sibling spec directory
 * with its own engine, its own worktree and its own branch, kept off the
 * Kanban board. The backend runner (`runners/best_of_n_runner.py`) sets the
 * variants up, ranks them and adopts or discards them; the builds in between
 * are ordinary `run.py` processes, started here through the agent manager so
 * they get the same credentials, logs and shutdown as any task. When the last
 * build ends, the variants are ranked. Nothing is merged: the person picks a
 * variant on the card, confirms, and only then is it made the task's build.
 *
 * The renderer names the task and the engines. The spec directory is read
 * here from the task record, and the runner resolves it again before use
 * (docs/rules/security.md, S4 and S6).
 *
 * Channels:
 *   invoke TASK_BEST_OF_N_START   (taskId, engines) → IPCResult<BestOfNStatus>
 *   invoke TASK_BEST_OF_N_STATUS  (taskId)          → IPCResult<BestOfNStatus>
 *   invoke TASK_BEST_OF_N_RANK    (taskId)          → IPCResult<BestOfNStatus>
 *   invoke TASK_BEST_OF_N_ADOPT   (taskId, specId)  → IPCResult<BestOfNStatus>
 *   invoke TASK_BEST_OF_N_DISCARD (taskId)          → IPCResult<BestOfNStatus>
 *   send   TASK_BEST_OF_N_EVENT   (taskId, BestOfNStatus)
 */

import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, type BrowserWindow, ipcMain } from "electron";
import { getSpecsDir, IPC_CHANNELS } from "../../../shared/constants";
import type {
	BestOfNState,
	BestOfNStatus,
	EngineTrio,
	IPCResult,
	Project,
	Task,
} from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { projectStore } from "../../project-store";
import { parsePythonCommand } from "../../python-detector";
import { pythonEnvManager } from "../../python-env-manager";
import { pythonRunnerEnv } from "../../utils/python-runner-env";
import { findTaskAndProject } from "./shared";

const RUNNER = "best_of_n_runner.py";
export const STATE_FILE = "best_of_n.json";
export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 4;
/** Between two builds' starts: each reads and writes the same repository. */
const START_SPACING_MS = 1500;
const DISCARD_WAIT_MS = 15_000;

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFORT = /^[a-z][a-z_-]{0,31}$/;
const VARIANT_ID = /-bon[1-4]$/;

type Busy = NonNullable<BestOfNStatus["busy"]>;

interface Run {
	project: Project;
	task: Task;
	specDir: string;
	/** Variants whose build has been asked for and has not ended. */
	live: Set<string>;
	busy?: Busy;
	error?: string;
}

const runs = new Map<string, Run>();
/** Every variant started since the app opened: their exits are not a task's. */
const variantIds = new Set<string>();

/** Whether `taskId` is a best-of-N variant's build, not a board task. */
export function isBestOfNVariant(taskId: string): boolean {
	return VARIANT_ID.test(taskId) && variantIds.has(taskId);
}

/** Engines from the renderer, reduced to what the runner accepts. */
export function sanitizeEngines(raw: unknown): EngineTrio[] | string {
	if (!Array.isArray(raw)) return "The variants must be a list";
	if (raw.length < MIN_VARIANTS || raw.length > MAX_VARIANTS) {
		return `A best-of-N run has between ${MIN_VARIANTS} and ${MAX_VARIANTS} variants`;
	}
	const engines: EngineTrio[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") return "Each variant must be an object";
		const { provider, model, effort } = item as Record<string, unknown>;
		if (typeof provider !== "string" || !PROVIDER.test(provider)) {
			return "A variant has no valid provider";
		}
		if (
			typeof model !== "string" ||
			!model.trim() ||
			model.length > 200 ||
			[...model].some((c) => c.charCodeAt(0) < 32)
		) {
			return "A variant has no valid model";
		}
		if (typeof effort !== "string" || !EFFORT.test(effort)) {
			return "A variant has no valid effort";
		}
		engines.push({ provider, model: model.trim(), effort } as EngineTrio);
	}
	return engines;
}

/** The runner's one JSON line. */
export function parseRunnerOutput(stdout: string): { state?: BestOfNState; error?: string } {
	const lines = stdout.trim().split("\n").reverse();
	for (const line of lines) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			const payload = JSON.parse(text) as Record<string, unknown>;
			if (typeof payload.error === "string") return { error: payload.error };
			if (payload.state && typeof payload.state === "object") {
				return { state: payload.state as BestOfNState };
			}
		} catch {
			// Not ours.
		}
	}
	return { error: "The best-of-N runner gave no answer" };
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

function specDirOf(project: Project, task: Task): string {
	return path.join(project.path, getSpecsDir(project.autoBuildPath || undefined), task.specId);
}

export function readState(specDir: string): BestOfNState | null {
	try {
		const data = JSON.parse(readFileSync(path.join(specDir, STATE_FILE), "utf-8"));
		return data && typeof data === "object" && Array.isArray(data.variants) ? data : null;
	} catch {
		return null;
	}
}

function writeState(specDir: string, state: BestOfNState): void {
	const file = path.join(specDir, STATE_FILE);
	const partial = `${file}.partial`;
	writeFileSync(partial, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
	renameSync(partial, file);
}

async function runRunner(
	command: "prepare" | "rank" | "adopt" | "discard",
	project: Project,
	specDir: string,
	extra: string[] = [],
): Promise<{ state?: BestOfNState; error?: string }> {
	const pythonPath = pythonEnvManager.getPythonPath();
	if (!pythonPath) return { error: "Python environment not ready" };
	const backend = backendPath();
	const env = await pythonRunnerEnv(backend, {});
	const [exe, baseArgs] = parsePythonCommand(pythonPath);
	const args = [
		...baseArgs,
		path.join(backend, "runners", RUNNER),
		command,
		"--project-dir",
		project.path,
		"--spec-dir",
		specDir,
		...extra,
	];
	return new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exe, args, { cwd: backend, env });
		} catch (error) {
			resolve({ error: error instanceof Error ? error.message : "Failed to start" });
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appLog.debug("[BEST_OF_N]", chunk.toString().trim());
		});
		child.on("error", (err) => resolve({ error: err.message }));
		child.on("close", () => resolve(parseRunnerOutput(stdout)));
	});
}

export function registerBestOfNHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	const status = (taskId: string, specDir: string | null): BestOfNStatus => {
		const run = runs.get(taskId);
		let state = specDir ? readState(specDir) : null;
		// A build the app no longer runs, with no exit: the app stopped under it.
		if (state && specDir && state.phase === "running" && !run?.busy) {
			let changed = false;
			for (const variant of state.variants) {
				if (
					variant.exitCode === null &&
					!variant.interrupted &&
					!run?.live.has(variant.specId) &&
					!agentManager.isRunning(variant.specId)
				) {
					variant.interrupted = true;
					changed = true;
				}
			}
			if (changed) {
				writeState(specDir, state);
				state = readState(specDir);
			}
		}
		return {
			state,
			running: state
				? state.variants.map((v) => v.specId).filter((id) => agentManager.isRunning(id))
				: [],
			...(run?.busy && { busy: run.busy }),
			...(run?.error && { error: run.error }),
		};
	};

	const publish = (taskId: string) => {
		const run = runs.get(taskId);
		if (!run) return;
		getMainWindow()?.webContents.send(
			IPC_CHANNELS.TASK_BEST_OF_N_EVENT,
			taskId,
			status(taskId, run.specDir),
		);
	};

	const rankRun = async (taskId: string, run: Run) => {
		run.busy = "ranking";
		run.error = undefined;
		publish(taskId);
		const result = await runRunner("rank", run.project, run.specDir);
		run.busy = undefined;
		run.error = result.error;
		publish(taskId);
	};

	const variantEnded = (variantId: string, code: number) => {
		for (const [taskId, run] of runs) {
			if (!run.live.delete(variantId)) continue;
			const state = readState(run.specDir);
			const variant = state?.variants.find((v) => v.specId === variantId);
			if (state && variant && variant.exitCode === null) {
				variant.exitCode = code;
				writeState(run.specDir, state);
			}
			publish(taskId);
			if (run.live.size === 0 && !run.busy && state?.phase === "running") {
				void rankRun(taskId, run);
			}
		}
	};

	agentManager.on("exit", (taskId: string, code: number | null) => {
		if (isBestOfNVariant(taskId)) variantEnded(taskId, code ?? -1);
	});
	// A build that could not start says so with an error and no process.
	agentManager.on("error", (taskId: string) => {
		if (!isBestOfNVariant(taskId)) return;
		setTimeout(() => {
			if (!agentManager.isRunning(taskId)) variantEnded(taskId, -1);
		}, 1000);
	});

	const lookup = (taskId: unknown) => {
		if (typeof taskId !== "string" || !taskId) return { error: "taskId is required" };
		const { task, project } = findTaskAndProject(taskId);
		if (!task || !project) return { error: "Task not found" };
		return { task, project, specDir: specDirOf(project, task) };
	};

	const runFor = (task: Task, project: Project, specDir: string): Run => {
		let run = runs.get(task.id);
		if (!run) {
			run = { task, project, specDir, live: new Set() };
			runs.set(task.id, run);
		}
		return run;
	};

	ipcMain.handle(
		IPC_CHANNELS.TASK_BEST_OF_N_START,
		async (_, taskId: unknown, rawEngines: unknown): Promise<IPCResult<BestOfNStatus>> => {
			const found = lookup(taskId);
			if ("error" in found) return { success: false, error: found.error };
			const { task, project, specDir } = found;
			const engines = sanitizeEngines(rawEngines);
			if (typeof engines === "string") return { success: false, error: engines };
			if (agentManager.isRunning(task.id)) {
				return { success: false, error: "The task is running; stop it first" };
			}
			const run = runFor(task, project, specDir);
			if (run.busy || run.live.size > 0) {
				return { success: false, error: "A best-of-N run is already going" };
			}

			run.busy = "preparing";
			run.error = undefined;
			publish(task.id);
			const prepared = await runRunner("prepare", project, specDir, [
				"--variants",
				JSON.stringify(engines),
			]);
			if (!prepared.state) {
				run.busy = undefined;
				run.error = prepared.error;
				publish(task.id);
				return { success: false, error: prepared.error ?? "Setup failed" };
			}

			for (const [position, variant] of prepared.state.variants.entries()) {
				if (!VARIANT_ID.test(variant.specId)) continue;
				variantIds.add(variant.specId);
				run.live.add(variant.specId);
				if (position > 0) {
					await new Promise((resolve) => setTimeout(resolve, START_SPACING_MS));
				}
				try {
					await agentManager.startTaskExecution(
						variant.specId,
						project.path,
						variant.specId,
						{},
						project.id,
					);
				} catch (error) {
					appLog.warn("[BEST_OF_N] a variant did not start:", error);
					variantEnded(variant.specId, -1);
				}
			}
			run.busy = undefined;
			// Every build may have failed to start while the loop ran.
			if (run.live.size === 0 && readState(specDir)?.phase === "running") {
				void rankRun(task.id, run);
			}
			publish(task.id);
			return { success: true, data: status(task.id, specDir) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_BEST_OF_N_STATUS,
		async (_, taskId: unknown): Promise<IPCResult<BestOfNStatus>> => {
			const found = lookup(taskId);
			if ("error" in found) return { success: false, error: found.error };
			return { success: true, data: status(found.task.id, found.specDir) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_BEST_OF_N_RANK,
		async (_, taskId: unknown): Promise<IPCResult<BestOfNStatus>> => {
			const found = lookup(taskId);
			if ("error" in found) return { success: false, error: found.error };
			const run = runFor(found.task, found.project, found.specDir);
			if (run.busy || run.live.size > 0) {
				return { success: false, error: "Wait for every variant to end" };
			}
			await rankRun(found.task.id, run);
			return { success: true, data: status(found.task.id, found.specDir) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_BEST_OF_N_ADOPT,
		async (_, taskId: unknown, variantId: unknown): Promise<IPCResult<BestOfNStatus>> => {
			const found = lookup(taskId);
			if ("error" in found) return { success: false, error: found.error };
			const { task, project, specDir } = found;
			const state = readState(specDir);
			if (
				typeof variantId !== "string" ||
				!state?.variants.some((v) => v.specId === variantId)
			) {
				return { success: false, error: "That variant is not part of this run" };
			}
			const run = runFor(task, project, specDir);
			if (run.busy || run.live.size > 0) {
				return { success: false, error: "Wait for every variant to end" };
			}
			run.busy = "adopting";
			publish(task.id);
			const result = await runRunner("adopt", project, specDir, ["--variant", variantId]);
			run.busy = undefined;
			run.error = result.error;
			projectStore.invalidateTasksCache(project.id);
			publish(task.id);
			if (result.error) return { success: false, error: result.error };
			return { success: true, data: status(task.id, specDir) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_BEST_OF_N_DISCARD,
		async (_, taskId: unknown): Promise<IPCResult<BestOfNStatus>> => {
			const found = lookup(taskId);
			if ("error" in found) return { success: false, error: found.error };
			const { task, project, specDir } = found;
			const run = runFor(task, project, specDir);
			if (run.busy && run.busy !== "ranking") {
				return { success: false, error: "Wait for the current step to end" };
			}
			run.busy = "discarding";
			publish(task.id);
			const state = readState(specDir);
			for (const variant of state?.variants ?? []) {
				if (agentManager.isRunning(variant.specId)) agentManager.haltTask(variant.specId);
			}
			const deadline = Date.now() + DISCARD_WAIT_MS;
			while (
				state?.variants.some((v) => agentManager.isRunning(v.specId)) &&
				Date.now() < deadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			run.live.clear();
			const result = await runRunner("discard", project, specDir);
			run.busy = undefined;
			run.error = result.error;
			projectStore.invalidateTasksCache(project.id);
			publish(task.id);
			if (result.error) return { success: false, error: result.error };
			return { success: true, data: status(task.id, specDir) };
		},
	);
}
