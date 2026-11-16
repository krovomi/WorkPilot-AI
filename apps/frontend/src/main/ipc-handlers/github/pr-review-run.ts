/**
 * The local run of a PR review (first review and follow-up), out of
 * `pr-handlers.ts`: the registry of running reviews, the Python runner, and
 * the review the button starts (assignment, CI wait, then the run).
 *
 * One PR is reviewed once at a time: the slot is held before the first await,
 * by a placeholder until the runner is spawned, and freed on every exit.
 * Cancelling stops the runner and the processes it started (its tree).
 */

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS, MODEL_ID_MAP } from "../../../shared/constants";
import type { Project } from "../../../shared/types";
import type { AuthFailureInfo } from "../../../shared/types/terminal";
import { getPageFeatureSettings } from "../../services/page-llm-config";
import { performCIWaitCheck } from "./pr-ci-wait";
import type { PRReviewProgress } from "./pr-ci-wait";
import { getGitHubDir, PRLogCollector, sanitizeNetworkData } from "./pr-logs";
import { reviewFromJson } from "./review-result";
import type { PRReviewResult } from "./review-result";
import { getGitHubConfig, githubFetch } from "./utils";
import { createIPCCommunicators } from "./utils/ipc-communicator";
import { createContextLogger } from "./utils/logger";
import { getRunnerEnv } from "./utils/runner-env";
import {
	buildRunnerArgs,
	getPythonPath,
	getRunnerPath,
	killProcessTree,
	runPythonSubprocess,
	validateGitHubModule,
} from "./utils/subprocess-runner";

const { debug: debugLog } = createContextLogger("GitHub PR");

/** Held in the registry while a review waits for CI, before its runner exists. */
const CI_WAIT_PLACEHOLDER = Symbol("CI_WAIT_PLACEHOLDER");

/** `${projectId}:${prNumber}` → the runner, or the placeholder during the CI wait. */
const runningReviews = new Map<string, ChildProcess | typeof CI_WAIT_PLACEHOLDER>();

/** `${projectId}:${prNumber}` → what aborts the CI wait of that review. */
const ciWaitAbortControllers = new Map<string, AbortController>();

/** Grace given to a cancelled runner before it is killed. */
const CANCEL_GRACE_MS = 1000;

export type ReviewKind = "review" | "followup";

/** What tells a first review from a follow-up, everywhere they differ. */
const KINDS: Record<
	ReviewKind,
	{
		command: string;
		operationPrefix: string;
		label: "review" | "follow-up review";
		started: string;
		completed: string;
		failed: string;
		missing: string;
	}
> = {
	review: {
		command: "review-pr",
		operationPrefix: "pr-review",
		label: "review",
		started: "Assigning you to PR...",
		completed: "Review complete!",
		failed: "Review failed",
		missing: "Review completed but result not found",
	},
	followup: {
		command: "followup-review-pr",
		operationPrefix: "pr-followup-review",
		label: "follow-up review",
		started: "Starting follow-up review...",
		completed: "Follow-up review complete!",
		failed: "Follow-up review failed",
		missing: "Follow-up review completed but result not found",
	},
};

export function getReviewKey(projectId: string, prNumber: number): string {
	return `${projectId}:${prNumber}`;
}

/** Where the runner saves the review of a PR. */
export function getReviewPath(project: Project, prNumber: number): string {
	return path.join(getGitHubDir(project), "pr", `review_${prNumber}.json`);
}

/** The saved review of a PR, or null when there is none (or it is unreadable). */
export function getReviewResult(
	project: Project,
	prNumber: number,
): PRReviewResult | null {
	try {
		return reviewFromJson(fs.readFileSync(getReviewPath(project, prNumber), "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Env overrides from the project settings: CLAUDE.md is on unless turned off
 * (sent either way, the backend reads an absent variable as on), strict TDD
 * only when turned on.
 */
function getClaudeMdEnv(project: Project): Record<string, string> {
	const env: Record<string, string> = {
		USE_CLAUDE_MD: project.settings?.useClaudeMd !== false ? "true" : "false",
	};
	if (project.settings?.tddMode) env.TDD_MODE = "true";
	return env;
}

/** Model and thinking level of the GitHub PRs page (its own choice, else the settings). */
export function getGitHubPRSettings(): { model: string; thinkingLevel: string } {
	const { model: modelShort, thinkingLevel } = getPageFeatureSettings("github-prs");
	return { model: MODEL_ID_MAP[modelShort] ?? modelShort, thinkingLevel };
}

function reviewSenders(mainWindow: BrowserWindow, projectId: string) {
	return createIPCCommunicators<PRReviewProgress, PRReviewResult>(
		mainWindow,
		{
			progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
			error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
			complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
		},
		projectId,
	);
}

/** Whether a PR already has a review, saved or under way. */
export function hasPRReview(project: Project, prNumber: number): boolean {
	return (
		runningReviews.has(getReviewKey(project.id, prNumber)) ||
		getReviewResult(project, prNumber) !== null
	);
}

/** Holds the PR's slot until its runner starts; null when a review already holds it. */
function holdSlot(reviewKey: string): AbortController | null {
	if (runningReviews.has(reviewKey)) return null;
	runningReviews.set(reviewKey, CI_WAIT_PLACEHOLDER);
	const abortController = new AbortController();
	ciWaitAbortControllers.set(reviewKey, abortController);
	return abortController;
}

/** Frees a slot still held by its placeholder (a running runner frees its own). */
function releaseSlot(reviewKey: string): void {
	if (runningReviews.get(reviewKey) === CI_WAIT_PLACEHOLDER) {
		runningReviews.delete(reviewKey);
	}
	ciWaitAbortControllers.delete(reviewKey);
}

/** Runs the Python reviewer on a PR and resolves with the saved review. */
async function runPRReview(
	project: Project,
	prNumber: number,
	mainWindow: BrowserWindow,
	kind: ReviewKind,
): Promise<PRReviewResult> {
	const validation = await validateGitHubModule(project);
	if (!validation.valid || !validation.backendPath) {
		throw new Error(validation.error ?? "GitHub module validation failed");
	}
	const { backendPath } = validation;
	const { command, operationPrefix, label, failed, missing } = KINDS[kind];
	const { sendProgress } = reviewSenders(mainWindow, project.id);

	const { model, thinkingLevel } = getGitHubPRSettings();
	const args = buildRunnerArgs(
		getRunnerPath(backendPath),
		project.path,
		command,
		[prNumber.toString()],
		{ model, thinkingLevel },
	);
	debugLog(`Spawning PR ${label} process`, { args, model, thinkingLevel });

	const repo = getGitHubConfig(project)?.repo || project.name || "unknown";
	const logCollector = new PRLogCollector(project, prNumber, repo, kind === "followup");
	const env = await getRunnerEnv(getClaudeMdEnv(project), {
		jevWorkflow: "github-review",
		page: "github-prs",
	});
	const reviewKey = getReviewKey(project.id, prNumber);

	const { process: childProcess, promise } = runPythonSubprocess<PRReviewResult>({
		pythonPath: getPythonPath(backendPath),
		args,
		cwd: backendPath,
		env,
		onProgress: (percent, message) => {
			sendProgress({ phase: "analyzing", prNumber, progress: percent, message });
		},
		onStdout: (line) => logCollector.processLine(line),
		onStderr: (line) => debugLog("STDERR:", line),
		onAuthFailure: (authFailureInfo: AuthFailureInfo) => {
			mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_AUTH_FAILURE, authFailureInfo);
		},
		onComplete: () => {
			const reviewResult = getReviewResult(project, prNumber);
			if (!reviewResult) throw new Error(missing);
			return reviewResult;
		},
		// A review is one-shot: a profile swap stops it, it does not restart.
		operationRegistration: {
			operationId: `${operationPrefix}:${reviewKey}`,
			operationType: "pr-review",
			metadata: {
				projectId: project.id,
				prNumber,
				repo,
				...(kind === "followup" ? { isFollowup: true } : {}),
			},
		},
	});

	runningReviews.set(reviewKey, childProcess);
	try {
		const result = await promise;
		logCollector.finalize(result.success);
		if (!result.success || !result.data) throw new Error(result.error ?? failed);
		return result.data;
	} finally {
		// Not a review started after this one was cancelled.
		if (runningReviews.get(reviewKey) === childProcess) runningReviews.delete(reviewKey);
	}
}

/** Assigns the person who asked for the review; a failure does not stop it. */
async function assignCurrentUser(
	config: { token: string; repo: string },
	prNumber: number,
): Promise<void> {
	try {
		const user = (await githubFetch(config.token, "/user")) as { login: string };
		await githubFetch(config.token, `/repos/${config.repo}/issues/${prNumber}/assignees`, {
			method: "POST",
			body: JSON.stringify({ assignees: [user.login] }),
		});
	} catch (error) {
		debugLog("Failed to auto-assign user", { prNumber, error: String(error) });
	}
}

/**
 * The review the button starts. A first review assigns the person; both wait
 * for CI (cancellable), then run. Progress, result and failure reach the view
 * by the review events; a PR already under review is left to that review.
 */
export async function runButtonReview(
	project: Project,
	prNumber: number,
	mainWindow: BrowserWindow,
	kind: ReviewKind,
): Promise<void> {
	const { sendProgress, sendComplete, sendError } = reviewSenders(mainWindow, project.id);
	const { label, started, completed } = KINDS[kind];
	const reviewKey = getReviewKey(project.id, prNumber);
	const abortController = holdSlot(reviewKey);
	if (!abortController) {
		debugLog(`PR ${label} already running`, { reviewKey });
		return;
	}

	try {
		sendProgress({ phase: "fetching", prNumber, progress: 5, message: started });
		const config = getGitHubConfig(project);
		if (config) {
			if (kind === "review") await assignCurrentUser(config, prNumber);
			const proceed = await performCIWaitCheck(
				config,
				prNumber,
				sendProgress,
				label,
				abortController.signal,
			);
			if (!proceed) return;
		}
		ciWaitAbortControllers.delete(reviewKey);
		if (kind === "review") {
			sendProgress({
				phase: "fetching",
				prNumber,
				progress: 10,
				message: "Fetching PR data...",
			});
		}

		const result = await runPRReview(project, prNumber, mainWindow, kind);
		sendProgress({ phase: "complete", prNumber, progress: 100, message: completed });
		sendComplete(result);
	} catch (error) {
		debugLog(`PR ${label} failed`, {
			prNumber,
			error: error instanceof Error ? error.message : error,
		});
		sendError({
			prNumber,
			error: error instanceof Error ? error.message : `Failed to run PR ${label}`,
		});
	} finally {
		releaseSlot(reviewKey);
	}
}

/**
 * Starts the AI review of a PR for an automation (plan of 29 October, IA7).
 * Unlike the button it assigns nobody and does not wait for CI; like it, the
 * result is saved locally and never posted (`review-pr` runs without
 * `--auto-post`): posting stays the person's click in GitHub PRs. Resolves
 * once the review is launched; its progress and result reach the view by the
 * usual events.
 */
export async function startDraftPRReview(
	project: Project,
	prNumber: number,
	mainWindow: BrowserWindow,
): Promise<void> {
	if (!Number.isInteger(prNumber) || prNumber < 1) {
		throw new Error("Not a pull request number");
	}
	const reviewKey = getReviewKey(project.id, prNumber);
	// Held before the first await, so a click on the button meanwhile waits its turn.
	const abortController = holdSlot(reviewKey);
	if (!abortController) {
		throw new Error("A review of this PR is already running");
	}
	const release = () => releaseSlot(reviewKey);

	try {
		const validation = await validateGitHubModule(project);
		if (!validation.valid) throw new Error(validation.error);
		if (abortController.signal.aborted) throw new Error("The review was cancelled");
	} catch (error) {
		release();
		throw error;
	}

	const { sendComplete, sendError } = reviewSenders(mainWindow, project.id);
	ciWaitAbortControllers.delete(reviewKey);
	void runPRReview(project, prNumber, mainWindow, "review")
		.then(sendComplete, (error: unknown) => {
			debugLog("Automation PR review failed", {
				prNumber,
				error: error instanceof Error ? error.message : error,
			});
			sendError({
				prNumber,
				error: error instanceof Error ? error.message : "Failed to run PR review",
			});
		})
		.finally(release)
		// A window closed meanwhile: the result is on disk, the view reads it on open.
		.catch((error: unknown) => debugLog("Automation PR review not announced", { prNumber, error }));
}

/**
 * Cancels the local review of a PR: aborts its CI wait, or stops its runner
 * and what the runner started, then kills them after a grace period if they
 * are still there. False when no review of that PR runs here.
 */
export function cancelLocalReview(projectId: string, prNumber: number): boolean {
	const reviewKey = getReviewKey(projectId, prNumber);
	const entry = runningReviews.get(reviewKey);
	if (!entry) return false;
	runningReviews.delete(reviewKey);

	if (entry === CI_WAIT_PLACEHOLDER) {
		ciWaitAbortControllers.get(reviewKey)?.abort();
		ciWaitAbortControllers.delete(reviewKey);
		return true;
	}

	killProcessTree(entry, "SIGTERM");
	setTimeout(() => {
		if (entry.exitCode === null && entry.signalCode === null) {
			killProcessTree(entry, "SIGKILL");
		}
	}, CANCEL_GRACE_MS).unref?.();
	return true;
}

/**
 * Changes the saved review of a PR in place (its raw JSON, as the runner wrote
 * it). False when there is no saved review or it cannot be read or written.
 */
export function updateSavedReview(
	project: Project,
	prNumber: number,
	update: (data: Record<string, unknown>) => void,
): boolean {
	const reviewPath = getReviewPath(project, prNumber);
	try {
		const data = JSON.parse(sanitizeNetworkData(fs.readFileSync(reviewPath, "utf-8")));
		update(data);
		fs.writeFileSync(reviewPath, JSON.stringify(data, null, 2), "utf-8");
		return true;
	} catch (error) {
		debugLog("Saved review not updated", {
			prNumber,
			error: error instanceof Error ? error.message : error,
		});
		return false;
	}
}
