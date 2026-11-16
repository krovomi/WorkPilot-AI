/**
 * The local run of a merge request review (first review and follow-up), out
 * of `mr-review-handlers.ts`, as `github/pr-review-run.ts` is for pull
 * requests: the registry of running reviews, the Python runner, and the review
 * the button starts (assignment, then the run).
 *
 * One MR is reviewed once at a time: the slot is held before the first await,
 * by a placeholder until the runner is spawned, and freed on every exit.
 * Cancelling stops the runner and the processes it started (its tree).
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS, MODEL_ID_MAP } from "../../../shared/constants";
import type { Project } from "../../../shared/types";
import type { AuthFailureInfo } from "../../../shared/types/terminal";
import { getPageFeatureSettings } from "../../services/page-llm-config";
import { createIPCCommunicators } from "../github/utils/ipc-communicator";
import { createContextLogger } from "../github/utils/logger";
import { getRunnerEnv } from "../github/utils/runner-env";
import {
	buildRunnerArgs,
	findAppBackendPath,
	getPythonPath,
	killProcessTree,
	runPythonSubprocess,
} from "../github/utils/subprocess-runner";
import { mrReviewFromJson } from "./mr-review-result";
import type { MRReviewProgress, MRReviewResult } from "./types";
import { encodeProjectPath, getGitLabConfig, gitlabFetch } from "./utils";

const { debug: debugLog } = createContextLogger("GitLab MR");

/** The runner, inside the app's backend. */
const RUNNER = path.join("runners", "gitlab", "runner.py");

/** Held in the registry until a review's runner exists. */
const STARTING = Symbol("STARTING");

/** `${projectId}:${mrIid}` → the runner, or the placeholder before it starts. */
const runningReviews = new Map<string, ChildProcess | typeof STARTING>();

/** Grace given to a cancelled runner before it is killed. */
const CANCEL_GRACE_MS = 1000;

export type ReviewKind = "review" | "followup";

/** What tells a first review from a follow-up, everywhere they differ. */
const KINDS: Record<
	ReviewKind,
	{ command: string; started: string; completed: string; failed: string; missing: string }
> = {
	review: {
		command: "review-mr",
		started: "Assigning you to MR...",
		completed: "Review complete!",
		failed: "Review failed",
		missing: "Review completed but result not found",
	},
	followup: {
		command: "followup-review-mr",
		started: "Starting follow-up review...",
		completed: "Follow-up review complete!",
		failed: "Follow-up review failed",
		missing: "Follow-up review completed but result not found",
	},
};

function getReviewKey(projectId: string, mrIid: number): string {
	return `${projectId}:${mrIid}`;
}

/** Where the runner saves the review of a merge request. */
export function getReviewPath(project: Project, mrIid: number): string {
	return path.join(project.path, ".workpilot", "gitlab", "mr", `review_${mrIid}.json`);
}

/** The saved review of a merge request, or null when there is none (or it is unreadable). */
export function getReviewResult(project: Project, mrIid: number): MRReviewResult | null {
	try {
		return mrReviewFromJson(fs.readFileSync(getReviewPath(project, mrIid), "utf-8"));
	} catch {
		return null;
	}
}

/** Model and thinking level of the GitLab merge requests page (its own choice, else the settings). */
export function getGitLabMRSettings(): { model: string; thinkingLevel: string } {
	const { model: modelShort, thinkingLevel } = getPageFeatureSettings("gitlab-merge-requests");
	return { model: MODEL_ID_MAP[modelShort] ?? modelShort, thinkingLevel };
}

/**
 * The project's GitLab token, instance and project, from its settings (or
 * glab), for the review runner: the runner env carries no credential the main
 * process env happens to hold (github/utils/runner-env.ts).
 */
async function gitlabRunnerEnv(project: Project): Promise<Record<string, string>> {
	const config = await getGitLabConfig(project);
	return config
		? {
				GITLAB_TOKEN: config.token,
				GITLAB_INSTANCE_URL: config.instanceUrl,
				GITLAB_PROJECT: config.project,
			}
		: {};
}

function reviewSenders(mainWindow: BrowserWindow, projectId: string) {
	return createIPCCommunicators<MRReviewProgress, MRReviewResult>(
		mainWindow,
		{
			progress: IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS,
			error: IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR,
			complete: IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE,
		},
		projectId,
	);
}

/** Runs the Python reviewer on a merge request and resolves with the saved review. */
async function runMRReview(
	project: Project,
	mrIid: number,
	mainWindow: BrowserWindow,
	kind: ReviewKind,
): Promise<MRReviewResult> {
	const backendPath = findAppBackendPath(RUNNER);
	if (!backendPath) {
		throw new Error("GitLab runners not found. Please ensure the backend is properly installed.");
	}
	const { command, failed, missing } = KINDS[kind];
	const { sendProgress } = reviewSenders(mainWindow, project.id);
	const { model, thinkingLevel } = getGitLabMRSettings();
	// The GitLab runner's `--project` is the GitLab project: the folder goes in `--project-dir`.
	const args = buildRunnerArgs(path.join(backendPath, RUNNER), project.path, command, [String(mrIid)], {
		model,
		thinkingLevel,
		projectFlag: "--project-dir",
	});
	const env = await getRunnerEnv(await gitlabRunnerEnv(project), {
		jevWorkflow: "gitlab-review",
		page: "gitlab-merge-requests",
	});
	const reviewKey = getReviewKey(project.id, mrIid);

	const { process: childProcess, promise } = runPythonSubprocess<MRReviewResult>({
		pythonPath: getPythonPath(backendPath),
		args,
		cwd: backendPath,
		env,
		onProgress: (percent, message) => {
			sendProgress({ phase: "analyzing", mrIid, progress: percent, message });
		},
		onStdout: (line) => debugLog("STDOUT:", line),
		onStderr: (line) => debugLog("STDERR:", line),
		onAuthFailure: (authFailureInfo: AuthFailureInfo) => {
			mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_AUTH_FAILURE, authFailureInfo);
		},
		onComplete: () => {
			const reviewResult = getReviewResult(project, mrIid);
			if (!reviewResult) throw new Error(missing);
			return reviewResult;
		},
	});

	runningReviews.set(reviewKey, childProcess);
	try {
		const result = await promise;
		if (!result.success || !result.data) throw new Error(result.error ?? failed);
		return result.data;
	} finally {
		// Not a review started after this one was cancelled.
		if (runningReviews.get(reviewKey) === childProcess) runningReviews.delete(reviewKey);
	}
}

/** Assigns the person who asked for the review; a failure does not stop it. */
async function assignCurrentUser(project: Project, mrIid: number): Promise<void> {
	const config = await getGitLabConfig(project);
	if (!config) return;
	try {
		const user = (await gitlabFetch(config.token, config.instanceUrl, "/user")) as { id: number };
		await gitlabFetch(
			config.token,
			config.instanceUrl,
			`/projects/${encodeProjectPath(config.project)}/merge_requests/${mrIid}`,
			{ method: "PUT", body: JSON.stringify({ assignee_ids: [user.id] }) },
		);
	} catch (error) {
		debugLog("Failed to auto-assign user", { mrIid, error: String(error) });
	}
}

/**
 * The review the button starts. A first review assigns the person, then both
 * run. Progress, result and failure reach the view by the review events; a
 * merge request already under review is left to that review.
 */
export async function runButtonReview(
	project: Project,
	mrIid: number,
	mainWindow: BrowserWindow,
	kind: ReviewKind,
): Promise<void> {
	const reviewKey = getReviewKey(project.id, mrIid);
	if (runningReviews.has(reviewKey)) {
		debugLog("Review already running", { reviewKey, kind });
		return;
	}
	runningReviews.set(reviewKey, STARTING);
	const { sendProgress, sendComplete, sendError } = reviewSenders(mainWindow, project.id);
	const { started, completed } = KINDS[kind];

	try {
		sendProgress({ phase: "fetching", mrIid, progress: 5, message: started });
		if (kind === "review") {
			await assignCurrentUser(project, mrIid);
			sendProgress({ phase: "fetching", mrIid, progress: 10, message: "Fetching MR data..." });
		}
		// Cancelled before the runner started.
		if (runningReviews.get(reviewKey) !== STARTING) return;
		const result = await runMRReview(project, mrIid, mainWindow, kind);
		sendProgress({ phase: "complete", mrIid, progress: 100, message: completed });
		sendComplete(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const what = kind === "review" ? "MR review" : "Follow-up review";
		sendError({ mrIid, error: `${what} failed for MR #${mrIid}: ${message}` });
	} finally {
		if (runningReviews.get(reviewKey) === STARTING) runningReviews.delete(reviewKey);
	}
}

/**
 * Cancels the local review of a merge request: before its runner starts, the
 * run does not start; after, the runner and what it started are stopped, then
 * killed after a grace period if they are still there. False when no review
 * of that merge request runs here.
 */
export function cancelLocalReview(projectId: string, mrIid: number): boolean {
	const reviewKey = getReviewKey(projectId, mrIid);
	const entry = runningReviews.get(reviewKey);
	if (!entry) return false;
	runningReviews.delete(reviewKey);
	if (entry === STARTING) return true;

	killProcessTree(entry, "SIGTERM");
	setTimeout(() => {
		if (entry.exitCode === null && entry.signalCode === null) {
			killProcessTree(entry, "SIGKILL");
		}
	}, CANCEL_GRACE_MS).unref?.();
	return true;
}

/**
 * Changes the saved review of a merge request in place (its raw JSON, as the
 * runner wrote it), through a temporary file renamed over it. False when
 * there is no saved review or it cannot be read or written.
 */
export function updateSavedReview(
	project: Project,
	mrIid: number,
	update: (data: Record<string, unknown>) => void,
): boolean {
	const reviewPath = getReviewPath(project, mrIid);
	const tempPath = `${reviewPath}.tmp.${randomUUID()}`;
	try {
		const data = JSON.parse(fs.readFileSync(reviewPath, "utf-8")) as Record<string, unknown>;
		update(data);
		fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tempPath, reviewPath);
		return true;
	} catch (error) {
		fs.rmSync(tempPath, { force: true });
		debugLog("Saved review not updated", { mrIid, error: String(error) });
		return false;
	}
}
