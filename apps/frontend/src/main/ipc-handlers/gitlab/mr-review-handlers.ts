/**
 * GitLab MR Review IPC handlers: the saved review, the AI review and its
 * follow-up (`mr-review-run.ts`), posting it as a note, notes, merge,
 * assignees, approval, and whether the MR moved on since its review.
 *
 * Every channel registers on `mrIpcMain` (`mr-ipc-guard.ts`), which checks the
 * renderer's arguments before the handler runs. A server project's review
 * runs on the server (`server-mr-review.ts`).
 */

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { Project } from "../../../shared/types";
import { createContextLogger } from "../github/utils/logger";
import {
	withForgeProjectOrNull,
	withProjectOrNull,
} from "../github/utils/project-middleware";
import { serverProjectOf } from "../server-review-jobs";
import { mrIpcMain } from "./mr-ipc-guard";
import { mrReviewNote } from "./mr-review-result";
import {
	cancelLocalReview,
	getGitLabMRSettings,
	getReviewResult,
	type ReviewKind,
	runButtonReview,
	updateSavedReview,
} from "./mr-review-run";
import {
	cancelServerMRReview,
	postServerMRReview,
	serverMRReview,
	startServerMRReview,
} from "./server-mr-review";
import type { GitLabConfig, MRReviewResult, NewCommitsCheck } from "./types";
import { encodeProjectPath, getGitLabConfig, gitlabFetch } from "./utils";

const { debug: debugLog } = createContextLogger("GitLab MR");

const REBASE_POLL_INTERVAL_MS = 1000;
const DEFAULT_REBASE_TIMEOUT_MS = 60_000;

/** How long a merge waits for GitLab's rebase: `GITLAB_REBASE_TIMEOUT_MS`, else 60 s. */
export function rebaseTimeoutMs(value = process.env.GITLAB_REBASE_TIMEOUT_MS): number {
	const parsed = Number(value);
	return value && Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REBASE_TIMEOUT_MS;
}

/** The API path of a merge request of the configured project. */
function mrPath(config: GitLabConfig, mrIid: number, rest = ""): string {
	return `/projects/${encodeProjectPath(config.project)}/merge_requests/${mrIid}${rest}`;
}

async function waitForRebaseCompletion(config: GitLabConfig, mrIid: number): Promise<void> {
	const deadline = Date.now() + rebaseTimeoutMs();
	while (Date.now() < deadline) {
		const mr = (await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid))) as {
			rebase_in_progress?: boolean;
		};
		if (!mr.rebase_in_progress) return;
		await new Promise((resolve) => setTimeout(resolve, REBASE_POLL_INTERVAL_MS));
	}
	throw new Error("Rebase did not complete before timeout");
}

/**
 * Whether the merge request moved on since its saved review: the head the
 * review read against the head the merge request has now, and how many of
 * its commits (newest first) come after the reviewed one.
 */
async function newCommitsSince(
	project: Project,
	review: MRReviewResult | null,
	mrIid: number,
): Promise<NewCommitsCheck> {
	const reviewedSha = review?.reviewedCommitSha;
	if (!reviewedSha) return { hasNewCommits: false };
	const config = await getGitLabConfig(project);
	if (!config) return { hasNewCommits: false };

	try {
		const mr = (await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid))) as {
			sha?: string;
			diff_refs?: { head_sha?: string };
		};
		const currentSha = mr.sha || mr.diff_refs?.head_sha;
		if (reviewedSha === currentSha) {
			return { hasNewCommits: false, currentSha, reviewedSha };
		}
		const commits = (await gitlabFetch(
			config.token,
			config.instanceUrl,
			mrPath(config, mrIid, "/commits?per_page=100"),
		)) as Array<{ id: string }>;
		const reviewedAt = commits.findIndex((commit) => commit.id === reviewedSha);
		const newCommitCount = reviewedAt === -1 ? commits.length : reviewedAt;
		return { hasNewCommits: true, currentSha, reviewedSha, newCommitCount: newCommitCount || 1 };
	} catch (error) {
		debugLog("Error checking new commits", { mrIid, error: String(error) });
		return { hasNewCommits: false };
	}
}

/** Runs `action` with the project's GitLab config; false without one, or when it throws. */
async function withConfig(
	projectId: string,
	what: string,
	action: (config: GitLabConfig, project: Project) => Promise<void>,
): Promise<boolean> {
	const done = await withForgeProjectOrNull(projectId, async (project) => {
		const config = await getGitLabConfig(project);
		if (!config) return false;
		try {
			await action(config, project);
			return true;
		} catch (error) {
			debugLog(`Failed to ${what}`, { error: String(error) });
			return false;
		}
	});
	return done ?? false;
}

/** Register MR review handlers */
export function registerMRReviewHandlers(getMainWindow: () => BrowserWindow | null): void {
	/** The review button: on the server for a server project, else here. */
	const buttonReview = async (projectId: string, mrIid: number, kind: ReviewKind) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) return;
		const remote = serverProjectOf(projectId);
		if (remote) {
			startServerMRReview(remote, mrIid, kind === "followup", mainWindow, getGitLabMRSettings());
			return;
		}
		await withProjectOrNull(projectId, (project) =>
			runButtonReview(project, mrIid, mainWindow, kind),
		);
	};

	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_GET_REVIEW,
		async (_, projectId: string, mrIid: number): Promise<MRReviewResult | null> => {
			const remote = serverProjectOf(projectId);
			if (remote) return serverMRReview(remote, mrIid);
			return withProjectOrNull(projectId, async (project) => getReviewResult(project, mrIid));
		},
	);

	mrIpcMain.on(IPC_CHANNELS.GITLAB_MR_REVIEW, (_, projectId: string, mrIid: number) =>
		buttonReview(projectId, mrIid, "review"),
	);

	mrIpcMain.on(IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW, (_, projectId: string, mrIid: number) =>
		buttonReview(projectId, mrIid, "followup"),
	);

	// Post the saved review as a note, then mark what it posted.
	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_POST_REVIEW,
		async (_, projectId: string, mrIid: number, selectedFindingIds?: string[]) => {
			const remote = serverProjectOf(projectId);
			if (remote) return postServerMRReview(remote, mrIid, selectedFindingIds);
			const posted = await withProjectOrNull(projectId, async (project) => {
				const review = getReviewResult(project, mrIid);
				const config = review && (await getGitLabConfig(project));
				if (!review || !config) return false;
				const { body, findings } = mrReviewNote(review, selectedFindingIds);
				try {
					await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid, "/notes"), {
						method: "POST",
						body: JSON.stringify({ body }),
					});
				} catch (error) {
					debugLog("Failed to post review", { mrIid, error: String(error) });
					return false;
				}
				updateSavedReview(project, mrIid, (data) => {
					const before = Array.isArray(data.posted_finding_ids) ? data.posted_finding_ids : [];
					data.has_posted_findings = true;
					data.posted_finding_ids = [...new Set([...before, ...findings.map((f) => f.id)])];
				});
				return true;
			});
			return posted ?? false;
		},
	);

	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_POST_NOTE,
		async (_, projectId: string, mrIid: number, body: string): Promise<boolean> =>
			withConfig(projectId, "post note", async (config) => {
				await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid, "/notes"), {
					method: "POST",
					body: JSON.stringify({ body }),
				});
			}),
	);

	// A squash merge squashes; a rebase merge rebases on GitLab first, then merges.
	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_MERGE,
		async (
			_,
			projectId: string,
			mrIid: number,
			mergeMethod: "merge" | "squash" | "rebase" = "squash",
		): Promise<boolean> =>
			withConfig(projectId, "merge MR", async (config) => {
				if (mergeMethod === "rebase") {
					await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid, "/rebase"), {
						method: "PUT",
					});
					await waitForRebaseCompletion(config, mrIid);
				}
				await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid, "/merge"), {
					method: "PUT",
					body: JSON.stringify(mergeMethod === "squash" ? { squash: true } : {}),
				});
			}),
	);

	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_ASSIGN,
		async (_, projectId: string, mrIid: number, userIds: number[]): Promise<boolean> =>
			withConfig(projectId, "assign users", async (config) => {
				await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid), {
					method: "PUT",
					body: JSON.stringify({ assignee_ids: userIds }),
				});
			}),
	);

	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_APPROVE,
		async (_, projectId: string, mrIid: number): Promise<boolean> =>
			withConfig(projectId, "approve MR", async (config) => {
				await gitlabFetch(config.token, config.instanceUrl, mrPath(config, mrIid, "/approve"), {
					method: "POST",
				});
			}),
	);

	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL,
		async (_, projectId: string, mrIid: number): Promise<boolean> =>
			serverProjectOf(projectId)
				? cancelServerMRReview(projectId, mrIid)
				: cancelLocalReview(projectId, mrIid),
	);

	mrIpcMain.handle(
		IPC_CHANNELS.GITLAB_MR_CHECK_NEW_COMMITS,
		async (_, projectId: string, mrIid: number): Promise<NewCommitsCheck> => {
			const remote = serverProjectOf(projectId);
			const result = remote
				? await newCommitsSince(remote, await serverMRReview(remote, mrIid), mrIid)
				: await withProjectOrNull(projectId, async (project) =>
						newCommitsSince(project, getReviewResult(project, mrIid), mrIid),
					);
			return result ?? { hasNewCommits: false };
		},
	);
}
