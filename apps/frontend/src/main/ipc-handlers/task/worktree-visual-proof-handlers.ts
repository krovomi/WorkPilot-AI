
import path from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, VisualProofRun } from "../../../shared/types";
import { type PythonEnvManager } from "../../python-env-manager";
import { visualProofService } from "../../visual-proof-service";
import { findTaskWorktree } from "../../worktree-paths";
import { findTaskAndProject } from "./shared";
import { getTaskBaseBranch } from "./worktree-git-refs";
import {
	updateVisualProofMetadata,
	persistTaskPrUrl,
	detectExistingPrUrl,
} from "./worktree-pr-helpers";

export function registerWorktreeVisualProofHandlers(
	pythonEnvManager: PythonEnvManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	/**
	 * Run or retry automated visual proof.
	 *
	 * A PR is no longer required: when the task has no PR URL yet, the run still
	 * captures, stores and displays screenshots locally. GitHub blob URLs and the
	 * PR comment are attached only when a PR URL is known — otherwise they are
	 * added later by {@link IPC_CHANNELS.TASK_VISUAL_PROOF_SYNC} once a PR is
	 * detected on the branch.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_VISUAL_PROOF_RUN,
		async (_, taskId: string): Promise<IPCResult<VisualProofRun>> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// May be undefined — a run without a PR is now supported.
				const prUrl = task.prUrl ?? task.metadata?.prUrl;

				const specDir = path.join(
					project.path,
					project.autoBuildPath || ".workpilot",
					"specs",
					task.specId,
				);
				const worktreePath = findTaskWorktree(project.path, task.specId);
				const visualProof = await visualProofService.run({
					taskId: task.id,
					projectPath: project.path,
					specId: task.specId,
					prUrl,
					worktreePath: worktreePath ?? undefined,
					autoBuildPath: project.autoBuildPath,
				});

				updateVisualProofMetadata(
					specDir,
					worktreePath,
					project.autoBuildPath,
					task.specId,
					visualProof,
					(...args: unknown[]) => console.warn("[VISUAL_PROOF]", ...args),
				);

				const mainWindow = getMainWindow();
				if (mainWindow) {
					mainWindow.webContents.send(
						IPC_CHANNELS.TASK_UPDATED_EVENT,
						task.id,
						{ metadata: { visualProof } },
						project.id,
					);
				}

				return { success: true, data: visualProof };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to run visual proof",
				};
			}
		},
	);

	/**
	 * Sync stored visual-proof captures to a PR once one exists.
	 *
	 * The renderer calls this when the Visual Proof tab opens and after each run:
	 * if the task is not yet linked to a PR, we probe the branch for an existing
	 * PR (created any way — WorkPilot, gh, git, the web UI). When one is found we
	 * persist its URL onto the task and publish the already-captured screenshots
	 * to it (GitHub blob URLs + proof comment). No emulator is launched and no PR
	 * is ever created here.
	 *
	 * Returns `{ prUrl?, visualProof? }`: both absent means "no PR yet" (not an
	 * error). The renderer merges the result into its task metadata.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_VISUAL_PROOF_SYNC,
		async (
			_,
			taskId: string,
		): Promise<
			IPCResult<{ prUrl?: string; visualProof?: VisualProofRun }>
		> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// Already linked to a PR: nothing to sync.
				if (task.prUrl ?? task.metadata?.prUrl) {
					return { success: true, data: {} };
				}

				const specDir = path.join(
					project.path,
					project.autoBuildPath || ".workpilot",
					"specs",
					task.specId,
				);
				const worktreePath = findTaskWorktree(project.path, task.specId);

				const prUrl = await detectExistingPrUrl(
					pythonEnvManager,
					project,
					task.specId,
					getTaskBaseBranch(specDir),
				);
				if (!prUrl) {
					// No PR on the branch yet — expected, not a failure.
					return { success: true, data: {} };
				}

				// Link the task to the freshly-detected PR (without forcing "done").
				persistTaskPrUrl(
					specDir,
					worktreePath,
					project.autoBuildPath,
					task.specId,
					prUrl,
				);

				// Publish any already-captured run to the PR.
				const existingProof = task.metadata?.visualProof;
				let visualProof: VisualProofRun | undefined;
				if (existingProof) {
					visualProof = await visualProofService.publishToPr(
						existingProof,
						prUrl,
						worktreePath ?? undefined,
					);
					updateVisualProofMetadata(
						specDir,
						worktreePath,
						project.autoBuildPath,
						task.specId,
						visualProof,
						(...args: unknown[]) => console.warn("[VISUAL_PROOF_SYNC]", ...args),
					);
				}

				return { success: true, data: { prUrl, visualProof } };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to sync visual proof",
				};
			}
		},
	);

	/**
	 * Report whether a visual proof run is currently in progress for a task. The
	 * renderer queries this on mount so the spinner is restored after the tab was
	 * closed/reopened, and so a second run cannot be triggered while one is live.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_VISUAL_PROOF_STATUS,
		async (_, taskId: string): Promise<IPCResult<{ running: boolean }>> => {
			return {
				success: true,
				data: { running: visualProofService.isRunning(taskId) },
			};
		},
	);

	// Forward visual proof start/finish to the renderer so every open tab can keep
	// its spinner in sync, even one that did not initiate the run. Registered once
	// (registerWorktreeHandlers runs at startup) to avoid stacking listeners.
	if (visualProofService.listenerCount("running-changed") === 0) {
		visualProofService.on(
			"running-changed",
			(taskId: string, running: boolean) => {
				getMainWindow()?.webContents.send(
					IPC_CHANNELS.TASK_VISUAL_PROOF_RUNNING,
					taskId,
					running,
				);
			},
		);
	}
}
