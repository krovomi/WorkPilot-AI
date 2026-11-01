/**
 * The AI review of a server project's pull requests (server mode): the job
 * runs on the server (`../server-review-jobs.ts`), and this tells the GitHub
 * view, and posts a saved review to GitHub through the relay with the
 * person's own token, then records it on the server.
 */

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { Project } from "../../../shared/types";
import { isRequestNumber, serverReviewJobs } from "../server-review-jobs";
import type { PRReviewProgress } from "./pr-ci-wait";
import { postReviewToGitHub } from "./pr-review-post";
import { type PRReviewResult, reviewFromJson } from "./review-result";
import { serverGitHubConfig } from "./server-relay";
import { createIPCCommunicators } from "./utils/ipc-communicator";

export { serverProjectOf } from "../server-review-jobs";

const jobs = serverReviewJobs<PRReviewResult>("github", reviewFromJson);

/** The saved reviews of these pull requests, from the server. */
export const serverReviews = jobs.reviews;

/** Record on the server what the person posted of a review. */
export const markServerReviewPosted = jobs.markPosted;

/** Stop a review running on the server; false when none runs from here. */
export const cancelServerReview = jobs.cancel;

/**
 * Post a saved review to GitHub with the person's own token (the relay), and
 * record it on the server; false when it could not be posted.
 */
export async function postServerReview(
	project: Project,
	prNumber: number,
	selectedFindingIds?: unknown,
	options?: { forceApprove?: boolean },
): Promise<boolean> {
	const config = serverGitHubConfig(project);
	const review = isRequestNumber(prNumber)
		? (await serverReviews(project, [prNumber]))[prNumber]
		: null;
	if (!config || !review) return false;
	const selected = Array.isArray(selectedFindingIds)
		? selectedFindingIds.filter((id): id is string => typeof id === "string")
		: undefined;
	try {
		const { reviewId, findings } = await postReviewToGitHub(
			config,
			prNumber,
			review,
			selected,
			{ forceApprove: options?.forceApprove === true },
		);
		return markServerReviewPosted(project, prNumber, {
			findingIds: findings.map((f) => f.id),
			reviewId,
		});
	} catch {
		return false;
	}
}

/** Review a pull request on the server and tell the GitHub view. */
export function startServerReview(
	project: Project,
	prNumber: number,
	followup: boolean,
	mainWindow: BrowserWindow,
	settings: { model: string; thinkingLevel: string },
): void {
	const { sendProgress, sendComplete, sendError } = createIPCCommunicators<
		PRReviewProgress,
		PRReviewResult
	>(
		mainWindow,
		{
			progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
			error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
			complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
		},
		project.id,
	);
	jobs.start(project, prNumber, followup, settings, {
		progress: (phase, progress, message) =>
			sendProgress({ phase, prNumber, progress, message }),
		complete: sendComplete,
		error: sendError,
	});
}
