/**
 * GitHub PR Review IPC handlers
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis
 * 3. Post review comments
 * 4. Apply fixes
 */

import type { BrowserWindow } from "electron";
import { prIpcMain as ipcMain } from "./pr-ipc-guard";
import { IPC_CHANNELS } from "../../../shared/constants";
import { getGitHubConfig, githubFetch } from "./utils";
import { createContextLogger } from "./utils/logger";
import {
	withForgeProjectOrNull,
	withProjectOrNull,
} from "./utils/project-middleware";
import { prComment, prDiff, prMerge, prUpdateBranch } from "./pr-actions";
import { fetchPRsFromGraphQL } from "./pr-graphql";
import type { PRData, PRListResult } from "./pr-graphql";
import { loadPRLogs } from "./pr-logs";
import type { PRLogs } from "./pr-logs";
import {
	checkMergeReadiness,
	checkNewCommits,
	NO_NEW_COMMITS,
	UNKNOWN_READINESS,
} from "./pr-freshness";
import type { MergeReadiness, NewCommitsCheck } from "./pr-freshness";
import { readPRReviewMemories } from "./pr-review-memory";
import type { PRReviewMemory } from "./pr-review-memory";
import { postReviewToGitHub } from "./pr-review-post";
import {
	cancelLocalReview,
	getGitHubPRSettings,
	getReviewResult,
	runButtonReview,
	updateSavedReview,
} from "./pr-review-run";
import type { ReviewKind } from "./pr-review-run";
import {
	cancelServerReview,
	markServerReviewPosted,
	postServerReview,
	serverProjectOf,
	serverReviews,
	startServerReview,
} from "./server-pr-review";
import type { PRReviewResult } from "./review-result";
// Moved to ./review-result.ts, shared with a server project's review.
export type { PRReviewFinding, PRReviewResult } from "./review-result";
// Moved to ./pr-ci-wait.ts (audit lot L11, F36); re-exported for existing importers.
export type { PRReviewProgress } from "./pr-ci-wait";

// Moved to ./pr-graphql.ts (audit lot L11, F36); re-exported for existing importers.
export type { PRData, PRListResult } from "./pr-graphql";

// Debug logging
const { debug: debugLog } = createContextLogger("GitHub PR");

export type { MergeReadiness, NewCommitsCheck } from "./pr-freshness";
export type { PRReviewMemory } from "./pr-review-memory";
// Moved to ./pr-review-run.ts with the registry of running reviews.
export { hasPRReview, startDraftPRReview } from "./pr-review-run";

/**
 * Register PR-related handlers
 */
export function registerPRHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	debugLog("Registering PR handlers");

	// The review buttons: a server project's review runs on the server.
	const buttonReview = async (projectId: string, prNumber: number, kind: ReviewKind) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) return;
		const remote = serverProjectOf(projectId);
		if (remote) {
			startServerReview(remote, prNumber, kind === "followup", mainWindow, getGitHubPRSettings());
			return;
		}
		await withProjectOrNull(projectId, (project) =>
			runButtonReview(project, prNumber, mainWindow, kind),
		);
	};

	// List open PRs - fetches up to 100 open PRs at once, returns hasNextPage and endCursor from API
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_LIST,
		async (_, projectId: string): Promise<PRListResult> => {
			debugLog("listPRs handler called", { projectId });
			const result = await withForgeProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				if (!config) {
					debugLog("No GitHub config found for project");
					return { prs: [], hasNextPage: false, endCursor: null };
				}
				return fetchPRsFromGraphQL(config, null, "initial");
			});
			return result ?? { prs: [], hasNextPage: false, endCursor: null };
		},
	);

	// Load more PRs (pagination) - fetches next page of PRs using cursor
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_LIST_MORE,
		async (_, projectId: string, cursor: string): Promise<PRListResult> => {
			debugLog("listMorePRs handler called", { projectId, cursor });
			const result = await withForgeProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				if (!config) {
					debugLog("No GitHub config found for project");
					return { prs: [], hasNextPage: false, endCursor: null };
				}
				return fetchPRsFromGraphQL(config, cursor, "pagination");
			});
			return result ?? { prs: [], hasNextPage: false, endCursor: null };
		},
	);

	// Get single PR
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_GET,
		async (_, projectId: string, prNumber: number): Promise<PRData | null> => {
			debugLog("getPR handler called", { projectId, prNumber });
			return withForgeProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				if (!config) return null;

				try {
					const pr = (await githubFetch(
						config.token,
						`/repos/${config.repo}/pulls/${prNumber}`,
					)) as {
						number: number;
						title: string;
						body?: string;
						state: string;
						user: { login: string };
						head: { ref: string };
						base: { ref: string };
						additions: number;
						deletions: number;
						changed_files: number;
						assignees?: Array<{ login: string }>;
						created_at: string;
						updated_at: string;
						html_url: string;
					};

					const files = (await githubFetch(
						config.token,
						`/repos/${config.repo}/pulls/${prNumber}/files`,
					)) as Array<{
						filename: string;
						additions: number;
						deletions: number;
						status: string;
					}>;

					return {
						number: pr.number,
						title: pr.title,
						body: pr.body ?? "",
						state: pr.state,
						author: { login: pr.user.login },
						headRefName: pr.head.ref,
						baseRefName: pr.base.ref,
						additions: pr.additions ?? 0,
						deletions: pr.deletions ?? 0,
						changedFiles: pr.changed_files ?? 0,
						assignees:
							pr.assignees?.map((a: { login: string }) => ({
								login: a.login,
							})) ?? [],
						files: files.map((f) => ({
							path: f.filename,
							additions: f.additions ?? 0,
							deletions: f.deletions ?? 0,
							status: f.status,
						})),
						createdAt: pr.created_at,
						updatedAt: pr.updated_at,
						htmlUrl: pr.html_url,
					};
				} catch {
					return null;
				}
			});
		},
	);

	// Get PR diff
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_GET_DIFF,
		async (_, projectId: string, prNumber: number): Promise<string | null> => {
			return withForgeProjectOrNull(projectId, async (project) => {
				if (!getGitHubConfig(project)) return null;
				try {
					return await prDiff(project, prNumber);
				} catch {
					return null;
				}
			});
		},
	);

	// Get saved review
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_GET_REVIEW,
		async (
			_,
			projectId: string,
			prNumber: number,
		): Promise<PRReviewResult | null> => {
			const remote = serverProjectOf(projectId);
			if (remote) return (await serverReviews(remote, [prNumber]))[prNumber] ?? null;
			return withProjectOrNull(projectId, async (project) => {
				return getReviewResult(project, prNumber);
			});
		},
	);

	// Batch get saved reviews - more efficient than individual calls
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH,
		async (
			_,
			projectId: string,
			prNumbers: number[],
		): Promise<Record<number, PRReviewResult | null>> => {
			debugLog("getReviewsBatch handler called", {
				projectId,
				count: prNumbers.length,
			});
			const remote = serverProjectOf(projectId);
			if (remote) return serverReviews(remote, prNumbers);
			const result = await withProjectOrNull(projectId, async (project) => {
				const reviews: Record<number, PRReviewResult | null> = {};
				for (const prNumber of prNumbers) {
					reviews[prNumber] = getReviewResult(project, prNumber);
				}
				debugLog("Batch loaded reviews", {
					count: Object.values(reviews).filter((r) => r !== null).length,
				});
				return reviews;
			});
			return result ?? {};
		},
	);

	// Get PR review logs
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_GET_LOGS,
		async (_, projectId: string, prNumber: number): Promise<PRLogs | null> => {
			return withProjectOrNull(projectId, async (project) => {
				return loadPRLogs(project, prNumber);
			});
		},
	);

	// Run AI review (the button: assigns the person, waits for CI)
	ipcMain.on(IPC_CHANNELS.GITHUB_PR_REVIEW, (_, projectId: string, prNumber: number) =>
		buttonReview(projectId, prNumber, "review"),
	);

	// Post review to GitHub
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_POST_REVIEW,
		async (
			_,
			projectId: string,
			prNumber: number,
			selectedFindingIds?: string[],
			options?: { forceApprove?: boolean },
		): Promise<boolean> => {
			debugLog("postPRReview handler called", {
				projectId,
				prNumber,
				selectedCount: selectedFindingIds?.length,
				forceApprove: options?.forceApprove,
			});
			const remote = serverProjectOf(projectId);
			if (remote) {
				return postServerReview(remote, prNumber, selectedFindingIds, options);
			}
			const postResult = await withProjectOrNull(projectId, async (project) => {
				const result = getReviewResult(project, prNumber);
				if (!result) {
					debugLog("No review result found", { prNumber });
					return false;
				}

				const config = getGitHubConfig(project);
				if (!config) {
					debugLog("No GitHub config found");
					return false;
				}

				try {
					const { reviewId, findings } = await postReviewToGitHub(
						config,
						prNumber,
						result,
						selectedFindingIds,
						options,
					);
					debugLog("Review posted successfully", { prNumber, reviewId });

					// Record the review and its findings: a follow-up starts from them.
					updateSavedReview(project, prNumber, (data) => {
						data.review_id = reviewId;
						data.has_posted_findings = true;
						const posted = Array.isArray(data.posted_finding_ids) ? data.posted_finding_ids : [];
						data.posted_finding_ids = [...new Set([...posted, ...findings.map((f) => f.id)])];
						data.posted_at = new Date().toISOString();
					});
					return true;
				} catch (error) {
					debugLog("Failed to post review", {
						prNumber,
						error: error instanceof Error ? error.message : error,
					});
					return false;
				}
			});
			return postResult ?? false;
		},
	);

	// Mark review as posted (persists has_posted_findings to disk)
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_MARK_REVIEW_POSTED,
		async (_, projectId: string, prNumber: number): Promise<boolean> => {
			debugLog("markReviewPosted handler called", { projectId, prNumber });
			const remote = serverProjectOf(projectId);
			if (remote) return markServerReviewPosted(remote, prNumber);
			const result = await withProjectOrNull(projectId, async (project) =>
				updateSavedReview(project, prNumber, (data) => {
					data.has_posted_findings = true;
					data.posted_at = new Date().toISOString();
				}),
			);
			return result ?? false;
		},
	);

	// Post comment to PR
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_POST_COMMENT,
		async (
			_,
			projectId: string,
			prNumber: number,
			body: string,
		): Promise<boolean> => {
			debugLog("postPRComment handler called", { projectId, prNumber });
			const postResult = await withForgeProjectOrNull(projectId, async (project) => {
				try {
					debugLog("Posting comment to PR", { prNumber });
					await prComment(project, prNumber, body);
					debugLog("Comment posted successfully", { prNumber });
					return true;
				} catch (error) {
					debugLog("Failed to post comment", {
						prNumber,
						error: error instanceof Error ? error.message : error,
					});
					return false;
				}
			});
			return postResult ?? false;
		},
	);

	// Delete review from PR
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW,
		async (_, projectId: string, prNumber: number): Promise<boolean> => {
			debugLog("deletePRReview handler called", { projectId, prNumber });
			const deleteResult = await withProjectOrNull(
				projectId,
				async (project) => {
					const result = getReviewResult(project, prNumber);
					if (!result?.reviewId) {
						debugLog("No review ID found for deletion", { prNumber });
						return false;
					}

					const config = getGitHubConfig(project);
					if (!config) {
						debugLog("No GitHub config found");
						return false;
					}

					try {
						debugLog("Deleting review from GitHub", {
							prNumber,
							reviewId: result.reviewId,
						});

						// Delete review via GitHub API
						await githubFetch(
							config.token,
							`/repos/${config.repo}/pulls/${prNumber}/reviews/${result.reviewId}`,
							{
								method: "DELETE",
							},
						);

						debugLog("Review deleted successfully", {
							prNumber,
							reviewId: result.reviewId,
						});

						updateSavedReview(project, prNumber, (data) => {
							delete data.review_id;
						});
						return true;
					} catch (error) {
						debugLog("Failed to delete review", {
							prNumber,
							error: error instanceof Error ? error.message : error,
						});
						return false;
					}
				},
			);
			return deleteResult ?? false;
		},
	);

	// Merge PR
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_MERGE,
		async (
			_,
			projectId: string,
			prNumber: number,
			mergeMethod: "merge" | "squash" | "rebase" = "squash",
		): Promise<boolean> => {
			debugLog("mergePR handler called", { projectId, prNumber, mergeMethod });
			const mergeResult = await withForgeProjectOrNull(
				projectId,
				async (project) => {
					try {
						debugLog("Merging PR", { prNumber, method: mergeMethod });
						await prMerge(project, prNumber, mergeMethod);
						debugLog("PR merged successfully", { prNumber });
						return true;
					} catch (error) {
						debugLog("Failed to merge PR", {
							prNumber,
							error: error instanceof Error ? error.message : error,
						});
						return false;
					}
				},
			);
			return mergeResult ?? false;
		},
	);

	// Assign user to PR
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_ASSIGN,
		async (
			_,
			projectId: string,
			prNumber: number,
			username: string,
		): Promise<boolean> => {
			debugLog("assignPR handler called", { projectId, prNumber, username });
			const assignResult = await withForgeProjectOrNull(
				projectId,
				async (project) => {
					const config = getGitHubConfig(project);
					if (!config) return false;

					try {
						// Use GitHub API to add assignee
						await githubFetch(
							config.token,
							`/repos/${config.repo}/issues/${prNumber}/assignees`,
							{
								method: "POST",
								body: JSON.stringify({ assignees: [username] }),
							},
						);
						debugLog("User assigned successfully", { prNumber, username });
						return true;
					} catch (error) {
						debugLog("Failed to assign user", {
							prNumber,
							username,
							error: error instanceof Error ? error.message : error,
						});
						return false;
					}
				},
			);
			return assignResult ?? false;
		},
	);

	// Cancel PR review
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_REVIEW_CANCEL,
		async (_, projectId: string, prNumber: number): Promise<boolean> =>
			cancelServerReview(projectId, prNumber) || cancelLocalReview(projectId, prNumber),
	);

	// Check for new commits since last review
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS,
		async (_, projectId: string, prNumber: number): Promise<NewCommitsCheck> => {
			const result = await withForgeProjectOrNull(projectId, async (project) => {
				const review = project.remote
					? (await serverReviews(project, [prNumber]))[prNumber]
					: getReviewResult(project, prNumber);
				const config = review ? getGitHubConfig(project) : null;
				return review && config ? checkNewCommits(config, prNumber, review) : null;
			});
			return result ?? NO_NEW_COMMITS;
		},
	);

	// Check merge readiness (lightweight freshness check for verdict validation)
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS,
		async (_, projectId: string, prNumber: number): Promise<MergeReadiness> => {
			const result = await withForgeProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				return config ? checkMergeReadiness(config, prNumber) : null;
			});
			return result ?? UNKNOWN_READINESS;
		},
	);

	// Update PR branch (sync with base branch)
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH,
		async (
			_,
			projectId: string,
			prNumber: number,
		): Promise<{ success: boolean; error?: string }> => {
			debugLog("updateBranch handler called", { projectId, prNumber });

			const updateResult = await withForgeProjectOrNull(
				projectId,
				async (project) => {
					try {
						debugLog("Updating PR branch", { prNumber });
						await prUpdateBranch(project, prNumber);

						debugLog("PR branch updated successfully", { prNumber });
						return { success: true };
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						debugLog("Failed to update PR branch", {
							prNumber,
							error: errorMessage,
						});

						// Map common error patterns to user-friendly messages
						let friendlyError = errorMessage;
						if (
							errorMessage.includes("permission") ||
							errorMessage.includes("403")
						) {
							friendlyError =
								"You don't have permission to update this branch.";
						} else if (
							errorMessage.includes("401") ||
							errorMessage.toLowerCase().includes("auth") ||
							errorMessage.toLowerCase().includes("token")
						) {
							friendlyError =
								"Authentication failed. Try running 'gh auth login' to re-authenticate.";
						} else if (
							errorMessage.includes("404") ||
							errorMessage.includes("not found")
						) {
							friendlyError =
								"Pull request not found. It may have been closed or deleted.";
						} else if (
							errorMessage.includes("429") ||
							errorMessage.toLowerCase().includes("rate limit")
						) {
							friendlyError =
								"GitHub API rate limit exceeded. Please wait and try again.";
						} else if (errorMessage.includes("conflict")) {
							friendlyError =
								"Cannot update branch due to merge conflicts. Resolve conflicts manually.";
						} else if (
							errorMessage.toLowerCase().includes("protected") ||
							errorMessage.toLowerCase().includes("branch protection")
						) {
							friendlyError = "Branch protection rules prevent this update.";
						} else if (
							errorMessage.includes("ENOTFOUND") ||
							errorMessage.includes("ECONNREFUSED") ||
							errorMessage.includes("ETIMEDOUT")
						) {
							friendlyError =
								"Network error. Check your internet connection and try again.";
						} else if (
							errorMessage.toLowerCase().includes("already up to date")
						) {
							return { success: true }; // Not an error
						}

						return { success: false, error: friendlyError };
					}
				},
			);

			return updateResult ?? { success: false, error: "Project not found" };
		},
	);

	// Run follow-up review (waits for CI)
	ipcMain.on(
		IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW,
		(_, projectId: string, prNumber: number) =>
			buttonReview(projectId, prNumber, "followup"),
	);

	// Get workflows awaiting approval for a PR (fork PRs)
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL,
		async (
			_,
			projectId: string,
			prNumber: number,
		): Promise<{
			awaiting_approval: number;
			workflow_runs: Array<{
				id: number;
				name: string;
				html_url: string;
				workflow_name: string;
			}>;
			can_approve: boolean;
			error?: string;
		}> => {
			debugLog("getWorkflowsAwaitingApproval handler called", {
				projectId,
				prNumber,
			});
			const result = await withForgeProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				if (!config) {
					return {
						awaiting_approval: 0,
						workflow_runs: [],
						can_approve: false,
						error: "No GitHub config",
					};
				}

				try {
					// First get the PR's head SHA
					const prData = (await githubFetch(
						config.token,
						`/repos/${config.repo}/pulls/${prNumber}`,
					)) as { head?: { sha?: string } };

					const headSha = prData?.head?.sha;
					if (!headSha) {
						return {
							awaiting_approval: 0,
							workflow_runs: [],
							can_approve: false,
						};
					}

					// Query workflow runs with action_required status
					const runsData = (await githubFetch(
						config.token,
						`/repos/${config.repo}/actions/runs?status=action_required&per_page=100`,
					)) as {
						workflow_runs?: Array<{
							id: number;
							name: string;
							html_url: string;
							head_sha: string;
							workflow?: { name?: string };
						}>;
					};

					const allRuns = runsData?.workflow_runs || [];

					// Filter to only runs for this PR's head SHA
					const prRuns = allRuns
						.filter((run) => run.head_sha === headSha)
						.map((run) => ({
							id: run.id,
							name: run.name,
							html_url: run.html_url,
							workflow_name: run.workflow?.name || "Unknown",
						}));

					debugLog("Found workflows awaiting approval", {
						prNumber,
						count: prRuns.length,
					});

					return {
						awaiting_approval: prRuns.length,
						workflow_runs: prRuns,
						can_approve: true, // Assume token has permission; will fail if not
					};
				} catch (error) {
					debugLog("Failed to get workflows awaiting approval", {
						prNumber,
						error: error instanceof Error ? error.message : error,
					});
					return {
						awaiting_approval: 0,
						workflow_runs: [],
						can_approve: false,
						error: error instanceof Error ? error.message : "Unknown error",
					};
				}
			});

			return (
				result ?? {
					awaiting_approval: 0,
					workflow_runs: [],
					can_approve: false,
				}
			);
		},
	);

	// Approve a workflow run
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE,
		async (_, projectId: string, runId: number): Promise<boolean> => {
			debugLog("approveWorkflow handler called", { projectId, runId });
			const result = await withForgeProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				if (!config) {
					debugLog("No GitHub config found");
					return false;
				}

				try {
					// Approve the workflow run
					await githubFetch(
						config.token,
						`/repos/${config.repo}/actions/runs/${runId}/approve`,
						{
							method: "POST",
						},
					);

					debugLog("Workflow approved successfully", { runId });
					return true;
				} catch (error) {
					debugLog("Failed to approve workflow", {
						runId,
						error: error instanceof Error ? error.message : error,
					});
					return false;
				}
			});

			return result ?? false;
		},
	);

	// Get PR review memories from the memory layer
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_MEMORY_GET,
		async (_, projectId: string, limit?: number): Promise<PRReviewMemory[]> =>
			(await withProjectOrNull(projectId, async (project) =>
				readPRReviewMemories(project, limit),
			)) ?? [],
	);

	// Search PR review memories
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_MEMORY_SEARCH,
		async (_, projectId: string, query: string, limit?: number): Promise<PRReviewMemory[]> =>
			(await withProjectOrNull(projectId, async (project) =>
				readPRReviewMemories(project, limit, query),
			)) ?? [],
	);

	debugLog("PR handlers registered");
}
