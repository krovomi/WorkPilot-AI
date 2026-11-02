/**
 * What a multi-repo run uses of the app: the Python runner, the projects,
 * the Kanban tasks (created, started and stopped as the board does) and the
 * renderer. `run.ts` holds the logic; this file only wires it.
 */
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { Project } from "../../shared/types";
import { appLog } from "../app-logger";
import { getToolPath } from "../cli-tool-manager";
import { getTaskControl } from "../ipc-handlers/task/execution-handlers";
import { createLocalTask } from "../ipc-handlers/task/create-local-task";
import { safeSendToRenderer } from "../ipc-handlers/utils";
import { initializeProject } from "../project-initializer";
import { projectStore } from "../project-store";
import { parsePythonCommand } from "../python-detector";
import { pythonEnvManager } from "../python-env-manager";
import { taskStateManager } from "../task-state-manager";
import { pythonRunnerEnv } from "../utils/python-runner-env";
import { findTaskWorktree } from "../worktree-paths";
import { type RawManifest, toOrchestration } from "./manifest";
import {
	type MultiRepoHost,
	parseRunnerEvents,
	type RunnerEvent,
	type TaskSnapshot,
} from "./run";

const RUNNER = "multi_repo_runner.py";

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

function realpathOrSelf(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

async function runStep(
	args: readonly string[],
	signal: AbortSignal,
): Promise<{ ok: boolean; events: RunnerEvent[] }> {
	const pythonPath = pythonEnvManager.getPythonPath();
	if (!pythonPath) return { ok: false, events: [] };
	const backend = backendPath();
	const env = await pythonRunnerEnv(backend, {});
	const [exe, baseArgs] = parsePythonCommand(pythonPath);
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ ok: false, events: [] });
			return;
		}
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exe, [...baseArgs, path.join(backend, "runners", RUNNER), ...args], {
				cwd: backend,
				env,
			});
		} catch (error) {
			appLog.warn("[MultiRepo] Runner did not start:", error);
			resolve({ ok: false, events: [] });
			return;
		}
		const kill = () => child.kill();
		signal.addEventListener("abort", kill, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appLog.debug("[MultiRepo]", chunk.toString().trim());
		});
		const done = (ok: boolean) => {
			signal.removeEventListener("abort", kill);
			resolve({ ok, events: parseRunnerEvents(stdout) });
		};
		child.on("error", () => done(false));
		child.on("close", (code) => done(code === 0));
	});
}

/** The registered project of `repoPath`, added and initialized if needed. */
export function ensureRepoProject(repoPath: string): Project | null {
	const wanted = realpathOrSelf(repoPath);
	const project =
		projectStore
			.getProjects()
			.find((p) => !p.remote && realpathOrSelf(p.path) === wanted) ??
		projectStore.addProject(wanted);
	if (project.remote) return null;
	if (!project.autoBuildPath) {
		const result = initializeProject(project.path);
		if (!result.success && result.blocker !== "already-initialized") return null;
		projectStore.updateAutoBuildPath(project.id, ".workpilot");
	}
	return projectStore.getProject(project.id) ?? null;
}

function findTask(projectId: string, taskId: string) {
	projectStore.invalidateTasksCache(projectId);
	return projectStore.getTasks(projectId).find((t) => t.id === taskId) ?? null;
}

function branchOf(worktree: string): string {
	try {
		return execFileSync(getToolPath("git"), ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: worktree,
			encoding: "utf-8",
		}).trim();
	} catch {
		return "";
	}
}

/** The host of orchestration `id`, created from project `hostProjectId`. */
export function createMultiRepoHost(
	id: string,
	hostProjectId: string,
	getMainWindow: () => BrowserWindow | null,
): MultiRepoHost {
	return {
		runStep,
		ensureProject: (repoPath) => {
			const project = ensureRepoProject(repoPath);
			return project ? { id: project.id } : null;
		},
		createTask: async (projectId, title, description) => {
			const project = projectStore.getProject(projectId);
			if (!project || project.remote) return null;
			try {
				return createLocalTask(project, {
					title,
					aiDescription: description,
					displayDescription: description,
					descriptionIsHtml: false,
				}).id;
			} catch (error) {
				appLog.warn("[MultiRepo] Task creation failed:", error);
				return null;
			}
		},
		startTask: async (taskId) => (await getTaskControl()?.start(taskId)) ?? false,
		stopTask: (taskId) => {
			const control = getTaskControl();
			if (control?.isRunning(taskId)) control.stop(taskId);
		},
		taskSnapshot: (projectId, taskId): TaskSnapshot | null => {
			const task = findTask(projectId, taskId);
			return task ? { status: task.status, reviewReason: task.reviewReason } : null;
		},
		taskWorkspace: (projectId, taskId) => {
			const project = projectStore.getProject(projectId);
			const task = findTask(projectId, taskId);
			const worktree = project && task ? findTaskWorktree(project.path, task.specId) : null;
			return {
				worktreePath: worktree ?? "",
				branchName: worktree ? branchOf(worktree) : "",
				baseBranch: task?.metadata?.baseBranch || project?.settings?.mainBranch || "",
				prUrl: task?.prUrl || task?.metadata?.prUrl || "",
			};
		},
		onTaskStatus: (listener) =>
			taskStateManager.addStatusListener((taskId, status, reviewReason, projectId) =>
				listener(taskId, projectId, { status, reviewReason }),
			),
		publish: (manifest: RawManifest, running: boolean) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.MULTI_REPO_UPDATED,
				toOrchestration(id, hostProjectId, manifest, running),
			);
		},
	};
}
