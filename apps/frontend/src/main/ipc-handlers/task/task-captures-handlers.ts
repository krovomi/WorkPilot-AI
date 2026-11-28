/**
 * The Captures tab of a task (`renderer/components/task-detail/TaskCaptures.tsx`):
 * read what the task prepared for its pull request, show a published copy,
 * publish, withdraw or update the PR's section.
 *
 * The renderer names a task and, for an image, a file the publication lists;
 * nothing else. The project, the spec folder, the base branch and the
 * runner's arguments all come from the main process (`task-captures-runner.ts`);
 * a server card's image comes from the server (`task-captures/server-captures.ts`).
 */

import path from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import { getSpecsDir, IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type {
	TaskCaptureImage,
	TaskCapturesActionResult,
	TaskCapturesSummary,
} from "../../../shared/types/task-captures";
import type { PythonEnvManager } from "../../python-env-manager";
import { findServerCard } from "../../server-board-actions";
import { taskCapturesDir } from "../../task-captures/attach";
import {
	readCapturesSummary,
	readCapturesSync,
	readPublishedImage,
} from "../../task-captures/read-captures";
import { readServerCaptureImage } from "../../task-captures/server-captures";
import { findTaskAndProject } from "./shared";
import { isCapturesAction, runCapturesRunner } from "./task-captures-runner";
import { getTaskBaseBranch } from "./worktree-git-refs";

const MAX_ID = 200;

function validId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}

export function registerTaskCapturesHandlers(
	pythonEnvManager: PythonEnvManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	const located = (taskId: unknown) => {
		if (!validId(taskId)) return { error: "Invalid task id" } as const;
		// A server card is not in the project store: its project is one the
		// app listed, its captures files are in that project's mirror.
		const card = findServerCard(taskId);
		if (card) {
			const dir = taskCapturesDir(card.project, card.cardId, false);
			return { card, local: false, dir } as const;
		}
		const { task, project } = findTaskAndProject(taskId);
		if (!task || !project) return { error: "Task not found" } as const;
		const local = !project.remote;
		const dir = taskCapturesDir(project, task.specId, local);
		return { card: null, task, project, local, dir } as const;
	};

	const broadcast = (
		taskId: string,
		projectId: string,
		captures: TaskCapturesSummary | undefined,
	) => {
		getMainWindow()?.webContents.send(
			IPC_CHANNELS.TASK_UPDATED_EVENT,
			taskId,
			{ captures },
			projectId,
		);
	};

	ipcMain.handle(
		IPC_CHANNELS.TASK_CAPTURES_GET,
		async (_, taskId: unknown): Promise<IPCResult<TaskCapturesSummary | null>> => {
			const found = located(taskId);
			if ("error" in found) return { success: false, error: found.error };
			const captures = found.dir ? readCapturesSummary(found.dir) : undefined;
			return { success: true, data: captures ?? null };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_CAPTURES_IMAGE,
		async (_, taskId: unknown, file: unknown): Promise<IPCResult<TaskCaptureImage>> => {
			const found = located(taskId);
			if ("error" in found) return { success: false, error: found.error };
			const summary = found.dir ? readCapturesSummary(found.dir) : undefined;
			if (!found.dir || !summary) return { success: false, error: "not-listed" };
			// A server card's images stay on the server: the mirror has none.
			const image =
				found.card
					? await readServerCaptureImage(found.card, summary, file)
					: readPublishedImage(found.dir, summary, file);
			if ("error" in image) return { success: false, error: image.error };
			return { success: true, data: { base64: image.base64, mimeType: "image/png" } };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_CAPTURES_ACTION,
		async (
			_,
			taskId: unknown,
			action: unknown,
		): Promise<IPCResult<TaskCapturesActionResult>> => {
			if (!isCapturesAction(action)) {
				return { success: false, error: "invalid-action" };
			}
			const found = located(taskId);
			if ("error" in found) return { success: false, error: found.error };
			if (found.card || !found.local) return { success: false, error: "server-project" };
			if (!found.dir) return { success: false, error: "no-captures" };
			const specDir = path.join(
				found.project.path,
				getSpecsDir(found.project.autoBuildPath || undefined),
				found.task.specId,
			);
			const run = await runCapturesRunner(pythonEnvManager, found.project, {
				action,
				projectPath: found.project.path,
				specId: found.task.specId,
				targetBranch: getTaskBaseBranch(specDir),
			});
			// Read again whatever happened: approve/withdraw write before the sync.
			const dir = taskCapturesDir(found.project, found.task.specId, true) ?? found.dir;
			const captures = readCapturesSummary(dir);
			broadcast(found.task.id, found.project.id, captures);
			if (!run.ok) {
				return { success: false, error: run.error };
			}
			return {
				success: true,
				data: {
					captures,
					sync: captures?.sync ?? readCapturesSync(dir),
					// The runner found no open pull request for the task's branch.
					noPr: run.result.status === "no-pr",
				},
			};
		},
	);
}
