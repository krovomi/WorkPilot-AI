/**
 * CI/CD Triggers after an agent's pull request (#378).
 *
 * When a task's PR is opened from the app (the review's "Create PR", the bulk
 * dialog, the worktrees view, a generated review), the pipeline configured in
 * CI/CD Triggers starts on its own if its settings ask for it ("auto-trigger"
 * and "on pull request"). The run is kept in `.workpilot/cicd_runs.json` like
 * a manual one, marked `source: "auto"` with the task it was started for, and
 * on the task itself (`metadata.cicdRun`) so its card says what happened. The
 * manual trigger of the CI/CD page stays as it is.
 */
import { execFileSync } from "node:child_process";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { CicdAutoRun, Project, Task } from "../../../shared/types";
import { getToolPath } from "../../cli-tool-manager";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import { autoTriggerForTask } from "../cicd-triggers-handlers";
import { updateCicdRunMetadata } from "./worktree-pr-helpers";

function branchOf(worktreePath: string): string | undefined {
	try {
		const branch = execFileSync(getToolPath("git"), ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: worktreePath,
			encoding: "utf-8",
			env: getIsolatedGitEnv(),
		}).trim();
		return branch && branch !== "HEAD" ? branch : undefined;
	} catch {
		return undefined;
	}
}

export async function triggerCicdAfterAgentPR(input: {
	project: Project;
	task: Task;
	specDir: string;
	worktreePath: string;
	prUrl: string;
	getMainWindow: () => BrowserWindow | null;
	debug: (...args: unknown[]) => void;
}): Promise<CicdAutoRun | null> {
	const { project, task, specDir, worktreePath, prUrl, getMainWindow, debug } = input;
	const cicdRun = await autoTriggerForTask(project, "pr", {
		prUrl,
		branch: branchOf(worktreePath),
		taskId: task.id,
		specId: task.specId,
	});
	if (!cicdRun) return null;
	debug("CI/CD pipeline after the PR:", cicdRun.provider, cicdRun.status);
	updateCicdRunMetadata(
		{ specDir, worktreePath, autoBuildPath: project.autoBuildPath, specId: task.specId },
		cicdRun,
		debug,
	);
	getMainWindow()?.webContents.send(
		IPC_CHANNELS.TASK_UPDATED_EVENT,
		task.id,
		{ metadata: { cicdRun } },
		project.id,
	);
	return cicdRun;
}
