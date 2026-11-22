/**
 * The pre-analysis of a card about to start « En cours »
 * (docs/architecture/task-readiness.md). The renderer asks before it moves a
 * card there; this answers from the machine (git, sign-in) and, for a short
 * card, from one AI review whose verdict is kept for the same text.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, TaskReadiness } from "../../../shared/types";
import { isFirstStart, isShortCard } from "../../../shared/utils/task-readiness";
import { getAppLanguage } from "../../app-language";
import { checkGitStatus } from "../../project-initializer";
import { readinessReviewService } from "../../readiness-review-service";
import { findServerCard } from "../../server-board-actions";
import { ensureProfileManagerInitialized, requiresClaudeAuth } from "./execution-utils";
import { findTaskAndProject } from "./shared";

const READY: TaskReadiness = { ready: true };
/** Verdicts of the AI review, by task, for the text they were given. */
const reviewed = new Map<string, { text: string; readiness: TaskReadiness }>();
const MAX_REVIEWED = 200;

export async function checkTaskReadiness(taskId: string): Promise<TaskReadiness> {
	// A server card starts on the server, which runs its own checks.
	if (findServerCard(taskId)) return READY;
	const { task, project } = findTaskAndProject(taskId);
	// Unknown here: the start reports it, as before.
	if (!task || !project) return READY;

	const git = checkGitStatus(project.path);
	if (!git.isGitRepo) return { ready: false, problem: "no_git" };
	if (!git.hasCommits) return { ready: false, problem: "no_commit" };
	if (requiresClaudeAuth(task, project)) {
		const profiles = await ensureProfileManagerInitialized();
		if (!profiles.success || !profiles.profileManager.hasValidAuth()) return { ready: false, problem: "no_auth" };
	}

	if (!isFirstStart(task) || !isShortCard(task)) return READY;
	const text = `${task.title}\n${task.description ?? ""}`;
	const known = reviewed.get(taskId);
	if (known?.text === text) return known.readiness;
	const verdict = await readinessReviewService.review(task.title, task.description ?? "", getAppLanguage());
	// No verdict (no provider, timeout): the review is a help, never a wall.
	if (!verdict) return READY;
	const readiness: TaskReadiness = verdict.ready ? READY : { ready: false, questions: verdict.questions };
	if (reviewed.size >= MAX_REVIEWED) reviewed.delete(reviewed.keys().next().value as string);
	reviewed.set(taskId, { text, readiness });
	return readiness;
}

export function registerReadinessHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.TASK_CHECK_READINESS,
		async (_, taskId: unknown): Promise<IPCResult<TaskReadiness>> => {
			if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 200) {
				return { success: false, error: "Invalid task id" };
			}
			return { success: true, data: await checkTaskReadiness(taskId) };
		},
	);
}
