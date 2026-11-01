/**
 * The AI review of a server project's merge requests (server mode): the job
 * runs on the server (`../server-review-jobs.ts`), and this tells the GitLab
 * view, and posts a saved review as a note on the merge request through the
 * relay with the person's own token, then records it on the server.
 */

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { Project } from "../../../shared/types";
import { createIPCCommunicators } from "../github/utils/ipc-communicator";
import { isRequestNumber, serverReviewJobs } from "../server-review-jobs";
import { mrReviewFromJson, mrReviewNote } from "./mr-review-result";
import { serverGitLabConfig } from "./server-relay";
import type { MRReviewProgress, MRReviewResult } from "./types";
import { encodeProjectPath, gitlabFetch } from "./utils";

const jobs = serverReviewJobs<MRReviewResult>("gitlab", mrReviewFromJson);

/** The saved review of a merge request, from the server; null if none. */
export async function serverMRReview(
	project: Project,
	mrIid: number,
): Promise<MRReviewResult | null> {
	return isRequestNumber(mrIid)
		? ((await jobs.reviews(project, [mrIid]))[mrIid] ?? null)
		: null;
}

/** Stop a review running on the server; false when none runs from here. */
export const cancelServerMRReview = jobs.cancel;

/**
 * Post a saved review as a note on its merge request, with the person's own
 * token (the relay), and record it on the server; false when it could not be
 * posted.
 */
export async function postServerMRReview(
	project: Project,
	mrIid: number,
	selectedFindingIds?: unknown,
): Promise<boolean> {
	const config = serverGitLabConfig(project);
	const review = await serverMRReview(project, mrIid);
	if (!config || !review) return false;
	const selected = Array.isArray(selectedFindingIds)
		? selectedFindingIds.filter((id): id is string => typeof id === "string")
		: undefined;
	const { body, findings } = mrReviewNote(review, selected);
	try {
		await gitlabFetch(
			config.token,
			config.instanceUrl,
			`/projects/${encodeProjectPath(config.project)}/merge_requests/${mrIid}/notes`,
			{ method: "POST", body: JSON.stringify({ body }) },
		);
	} catch {
		return false;
	}
	return jobs.markPosted(project, mrIid, { findingIds: findings.map((f) => f.id) });
}

/** Review a merge request on the server and tell the GitLab view. */
export function startServerMRReview(
	project: Project,
	mrIid: number,
	followup: boolean,
	mainWindow: BrowserWindow,
	settings: { model: string; thinkingLevel: string },
): void {
	const { sendProgress, sendComplete, sendError } = createIPCCommunicators<
		MRReviewProgress,
		MRReviewResult
	>(
		mainWindow,
		{
			progress: IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS,
			error: IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR,
			complete: IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE,
		},
		project.id,
	);
	if (followup && jobs.isRunning(project.id, mrIid)) {
		sendError({ mrIid, error: "Review already in progress" });
		return;
	}
	jobs.start(project, mrIid, followup, settings, {
		progress: (phase, progress, message) =>
			sendProgress({ phase, mrIid, progress, message }),
		complete: sendComplete,
		error: (error) => sendError({ mrIid, error }),
	});
}
