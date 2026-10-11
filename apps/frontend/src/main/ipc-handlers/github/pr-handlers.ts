/**
 * GitHub PR Review IPC handlers
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis
 * 3. Post review comments
 * 4. Apply fixes
 */

import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS, MODEL_ID_MAP } from "../../../shared/constants";
import type { Project } from "../../../shared/types";
import type { AuthFailureInfo } from "../../../shared/types/terminal";
import { getAugmentedEnv } from "../../env-utils";
import { getGitHubConfig, githubFetch } from "./utils";
import { createIPCCommunicators } from "./utils/ipc-communicator";
import { createContextLogger } from "./utils/logger";
import { withProjectOrNull } from "./utils/project-middleware";
import { getPageFeatureSettings } from "../../services/page-llm-config";
import { getRunnerEnv } from "./utils/runner-env";
import {
	buildRunnerArgs,
	getPythonPath,
	getRunnerPath,
	runPythonSubprocess,
	validateGitHubModule,
} from "./utils/subprocess-runner";
import { fetchPRsFromGraphQL } from "./pr-graphql";
import type { PRData, PRListResult } from "./pr-graphql";
import {
	sanitizeNetworkData,
	getGitHubDir,
	loadPRLogs,
	PRLogCollector,
} from "./pr-logs";
import type { PRLogs } from "./pr-logs";
import { performCIWaitCheck } from "./pr-ci-wait";
import type { PRReviewProgress } from "./pr-ci-wait";
// Moved to ./pr-ci-wait.ts (audit lot L11, F36); re-exported for existing importers.
export type { PRReviewProgress } from "./pr-ci-wait";

// Moved to ./pr-graphql.ts (audit lot L11, F36); re-exported for existing importers.
export type { PRData, PRListResult } from "./pr-graphql";

// Debug logging
const { debug: debugLog } = createContextLogger("GitHub PR");

/**
 * Sentinel value indicating a review is waiting for CI checks to complete.
 * Used as a placeholder in runningReviews before the actual process is spawned.
 */
const CI_WAIT_PLACEHOLDER = Symbol("CI_WAIT_PLACEHOLDER");
type CIWaitPlaceholder = typeof CI_WAIT_PLACEHOLDER;

/**
 * Registry of running PR review processes
 * Key format: `${projectId}:${prNumber}`
 * Value can be:
 * - ChildProcess: actual running review process
 * - CI_WAIT_PLACEHOLDER: review is waiting for CI checks to complete
 */
const runningReviews = new Map<
	string,
	import("child_process").ChildProcess | CIWaitPlaceholder
>();

/**
 * Registry of abort controllers for CI wait cancellation
 * Key format: `${projectId}:${prNumber}`
 */
const ciWaitAbortControllers = new Map<string, AbortController>();

/**
 * Get the registry key for a PR review
 */
function getReviewKey(projectId: string, prNumber: number): string {
	return `${projectId}:${prNumber}`;
}

/**
 * Returns env var overrides derived from project settings for runner subprocesses.
 * - CLAUDE.md usage: enabled unless explicitly opted out.
 * - Strict TDD (Red-Green-Refactor): enabled only when opted in.
 */
function getClaudeMdEnv(project: Project): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	if (project.settings?.useClaudeMd !== false) {
		env.USE_CLAUDE_MD = "true";
	}
	if (project.settings?.tddMode) {
		env.TDD_MODE = "true";
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * PR review finding from AI analysis
 */
export interface PRReviewFinding {
	id: string;
	severity: "critical" | "high" | "medium" | "low";
	category:
		| "security"
		| "quality"
		| "style"
		| "test"
		| "docs"
		| "pattern"
		| "performance";
	title: string;
	description: string;
	file: string;
	line: number;
	endLine?: number;
	suggestedFix?: string;
	fixable: boolean;
}

/**
 * Complete PR review result
 */
export interface PRReviewResult {
	jev?: import("../../../shared/types/jev").JevObservation;
	prNumber: number;
	repo: string;
	success: boolean;
	findings: PRReviewFinding[];
	summary: string;
	overallStatus: "approve" | "request_changes" | "comment";
	reviewId?: number;
	reviewedAt: string;
	error?: string;
	// Follow-up review fields
	reviewedCommitSha?: string;
	reviewedFileBlobs?: Record<string, string>; // filename → blob SHA for rebase-resistant follow-ups
	isFollowupReview?: boolean;
	previousReviewId?: number;
	resolvedFindings?: string[];
	unresolvedFindings?: string[];
	newFindingsSinceLastReview?: string[];
	// Track if findings have been posted to GitHub (enables follow-up review)
	hasPostedFindings?: boolean;
	postedFindingIds?: string[];
	postedAt?: string;
}

/**
 * Result of checking for new commits since last review
 */
export interface NewCommitsCheck {
	hasNewCommits: boolean;
	newCommitCount: number;
	lastReviewedCommit?: string;
	currentHeadCommit?: string;
	/** Whether new commits happened AFTER findings were posted (for "Ready for Follow-up" status) */
	hasCommitsAfterPosting?: boolean;
	/** Whether new commits touch files that had findings (requires verification) */
	hasOverlapWithFindings?: boolean;
	/** Files from new commits that overlap with finding files */
	overlappingFiles?: string[];
	/** Whether this appears to be a merge from base branch (develop/main) */
	isMergeFromBase?: boolean;
}

/**
 * Lightweight merge readiness check result
 * Used for real-time validation of AI verdict freshness
 */
export interface MergeReadiness {
	/** PR is in draft mode */
	isDraft: boolean;
	/** GitHub's mergeable status */
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	/** Branch is behind base branch (out of date) */
	isBehind: boolean;
	/** Simplified CI status */
	ciStatus: "passing" | "failing" | "pending" | "none";
	/** List of blockers that contradict a "ready to merge" verdict */
	blockers: string[];
}

/**
 * PR review memory stored in the memory layer
 * Represents key insights and learnings from a PR review
 */
export interface PRReviewMemory {
	prNumber: number;
	repo: string;
	verdict: string;
	timestamp: string;
	summary: {
		verdict: string;
		verdict_reasoning?: string;
		finding_counts?: Record<string, number>;
		total_findings?: number;
		blockers?: string[];
		risk_assessment?: Record<string, string>;
	};
	keyFindings: Array<{
		severity: string;
		category: string;
		title: string;
		description: string;
		file: string;
		line: number;
	}>;
	patterns: string[];
	gotchas: string[];
	isFollowup: boolean;
}


/**
 * Get saved PR review result
 */
function getReviewResult(
	project: Project,
	prNumber: number,
): PRReviewResult | null {
	const reviewPath = path.join(
		getGitHubDir(project),
		"pr",
		`review_${prNumber}.json`,
	);

	try {
		const rawData = fs.readFileSync(reviewPath, "utf-8");
		const sanitizedData = sanitizeNetworkData(rawData);
		const data = JSON.parse(sanitizedData);
		return {
			prNumber: data.pr_number,
			repo: data.repo,
			success: data.success,
			findings:
				data.findings?.map((f: Record<string, unknown>) => ({
					id: f.id,
					severity: f.severity,
					category: f.category,
					title: f.title,
					description: f.description,
					file: f.file,
					line: f.line,
					endLine: f.end_line,
					suggestedFix: f.suggested_fix,
					fixable: f.fixable ?? false,
				})) ?? [],
			summary: data.summary ?? "",
			overallStatus: data.overall_status ?? "comment",
			reviewId: data.review_id,
			reviewedAt: data.reviewed_at ?? new Date().toISOString(),
			error: data.error,
			// Follow-up review fields (snake_case -> camelCase)
			reviewedCommitSha: data.reviewed_commit_sha,
			jev: data.jev,
			reviewedFileBlobs: data.reviewed_file_blobs,
			isFollowupReview: data.is_followup_review ?? false,
			previousReviewId: data.previous_review_id,
			resolvedFindings: data.resolved_findings ?? [],
			unresolvedFindings: data.unresolved_findings ?? [],
			newFindingsSinceLastReview: data.new_findings_since_last_review ?? [],
			// Track posted findings for follow-up review eligibility
			hasPostedFindings: data.has_posted_findings ?? false,
			postedFindingIds: data.posted_finding_ids ?? [],
			postedAt: data.posted_at,
		};
	} catch {
		// File doesn't exist or couldn't be read
		return null;
	}
}

// IPC communication helpers removed - using createIPCCommunicators instead

/**
 * Get GitHub PR model and thinking settings from app settings
 */
function getGitHubPRSettings(): { model: string; thinkingLevel: string } {
	// Provider × LLM × effort : ce que la page a choisi, sinon les réglages.
	// Une seule lecture, dans `services/page-llm-config`.
	const { model: modelShort, thinkingLevel } =
		getPageFeatureSettings("github-prs");

	// Convert model short name to full model ID
	const model = MODEL_ID_MAP[modelShort] ?? modelShort;

	debugLog("GitHub PR settings", { modelShort, model, thinkingLevel });

	return { model, thinkingLevel };
}

// getBackendPath function removed - using subprocess-runner utility instead

/**
 * Run the Python PR reviewer
 */
async function runPRReview(
	project: Project,
	prNumber: number,
	mainWindow: BrowserWindow,
): Promise<PRReviewResult> {
	// Comprehensive validation of GitHub module
	const validation = await validateGitHubModule(project);

	if (!validation.valid) {
		throw new Error(validation.error);
	}

	// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
	const backendPath = validation.backendPath!;

	const { sendProgress } = createIPCCommunicators<
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

	const { model, thinkingLevel } = getGitHubPRSettings();
	const args = buildRunnerArgs(
		getRunnerPath(backendPath),
		project.path,
		"review-pr",
		[prNumber.toString()],
		{ model, thinkingLevel },
	);

	debugLog("Spawning PR review process", { args, model, thinkingLevel });

	// Create log collector for this review
	const config = getGitHubConfig(project);
	const repo = config?.repo || project.name || "unknown";
	const logCollector = new PRLogCollector(project, prNumber, repo, false);

	// Build environment with project settings
	const subprocessEnv = await getRunnerEnv(getClaudeMdEnv(project), {
		jevWorkflow: "github-review",
		page: "github-prs",
	});

	// Create operation ID for this review
	const reviewKey = getReviewKey(project.id, prNumber);

	const { process: childProcess, promise } =
		runPythonSubprocess<PRReviewResult>({
			pythonPath: getPythonPath(backendPath),
			args,
			cwd: backendPath,
			env: subprocessEnv,
			onProgress: (percent, message) => {
				debugLog("Progress update", { percent, message });
				sendProgress({
					phase: "analyzing",
					prNumber,
					progress: percent,
					message,
				});
			},
			onStdout: (line) => {
				debugLog("STDOUT:", line);
				// Collect log entries
				logCollector.processLine(line);
			},
			onStderr: (line) => debugLog("STDERR:", line),
			onAuthFailure: (authFailureInfo: AuthFailureInfo) => {
				// Send auth failure to renderer to show modal
				debugLog("Auth failure detected in PR review", authFailureInfo);
				mainWindow.webContents.send(
					IPC_CHANNELS.CLAUDE_AUTH_FAILURE,
					authFailureInfo,
				);
			},
			onComplete: () => {
				// Load the result from disk
				const reviewResult = getReviewResult(project, prNumber);
				if (!reviewResult) {
					throw new Error("Review completed but result not found");
				}
				debugLog("Review result loaded", {
					findingsCount: reviewResult.findings.length,
				});
				return reviewResult;
			},
			// Register with OperationRegistry for proactive swap support
			operationRegistration: {
				operationId: `pr-review:${reviewKey}`,
				operationType: "pr-review",
				metadata: { projectId: project.id, prNumber, repo },
				// PR reviews don't support restart (would need to refetch PR data)
				// The review will complete or fail, and user can retry manually
			},
		});

	// Register the running process (keep legacy registry for cancel support)
	runningReviews.set(reviewKey, childProcess);
	debugLog("Registered review process", { reviewKey, pid: childProcess.pid });

	try {
		// Wait for the process to complete
		const result = await promise;

		if (!result.success) {
			// Finalize logs with failure
			logCollector.finalize(false);
			throw new Error(result.error ?? "Review failed");
		}

		// Finalize logs with success
		logCollector.finalize(true);

		// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
		return result.data!;
	} finally {
		// Clean up the registry when done (success or error)
		runningReviews.delete(reviewKey);
		debugLog("Unregistered review process", { reviewKey });
	}
}

/**
 * Register PR-related handlers
 */
export function registerPRHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	debugLog("Registering PR handlers");

	// List open PRs - fetches up to 100 open PRs at once, returns hasNextPage and endCursor from API
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_LIST,
		async (_, projectId: string): Promise<PRListResult> => {
			debugLog("listPRs handler called", { projectId });
			const result = await withProjectOrNull(projectId, async (project) => {
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
			const result = await withProjectOrNull(projectId, async (project) => {
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
			return withProjectOrNull(projectId, async (project) => {
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
			return withProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				if (!config) return null;

				try {
					const { execFileSync } = await import("node:child_process");
					// Validate prNumber to prevent command injection
					if (!Number.isInteger(prNumber) || prNumber <= 0) {
						throw new Error("Invalid PR number");
					}
					// Use execFileSync with arguments array to prevent command injection
					const diff = execFileSync("gh", ["pr", "diff", String(prNumber)], {
						cwd: project.path,
						encoding: "utf-8",
						env: getAugmentedEnv(),
					});
					return diff;
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

	// Run AI review
	ipcMain.on(
		IPC_CHANNELS.GITHUB_PR_REVIEW,
		async (_, projectId: string, prNumber: number) => {
			debugLog("runPRReview handler called", { projectId, prNumber });
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				debugLog("No main window available");
				return;
			}

			const reviewKey = getReviewKey(projectId, prNumber);

			try {
				await withProjectOrNull(projectId, async (project) => {
					const { sendProgress, sendComplete } = createIPCCommunicators<
						PRReviewProgress,
						PRReviewResult
					>(
						mainWindow,
						{
							progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
							error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
							complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
						},
						projectId,
					);

					// Check if already running
					if (runningReviews.has(reviewKey)) {
						debugLog("Review already running", { reviewKey });
						return;
					}

					// Register as running BEFORE CI wait to prevent race conditions
					// Use CI_WAIT_PLACEHOLDER sentinel until real process is spawned
					runningReviews.set(reviewKey, CI_WAIT_PLACEHOLDER);
					const abortController = new AbortController();
					ciWaitAbortControllers.set(reviewKey, abortController);
					debugLog("Registered review placeholder", { reviewKey });

					try {
						debugLog("Starting PR review", { prNumber });
						sendProgress({
							phase: "fetching",
							prNumber,
							progress: 5,
							message: "Assigning you to PR...",
						});

						// Auto-assign current user to PR
						const config = getGitHubConfig(project);
						if (config) {
							try {
								// Get current user
								const user = (await githubFetch(config.token, "/user")) as {
									login: string;
								};
								debugLog("Auto-assigning user to PR", {
									prNumber,
									username: user.login,
								});

								// Assign to PR
								await githubFetch(
									config.token,
									`/repos/${config.repo}/issues/${prNumber}/assignees`,
									{
										method: "POST",
										body: JSON.stringify({ assignees: [user.login] }),
									},
								);
								debugLog("User assigned successfully", {
									prNumber,
									username: user.login,
								});
							} catch (assignError) {
								// Don't fail the review if assignment fails, just log it
								debugLog("Failed to auto-assign user", {
									prNumber,
									error:
										assignError instanceof Error
											? assignError.message
											: assignError,
								});
							}
						}

						// Wait for CI checks to complete before starting review
						if (config) {
							const shouldProceed = await performCIWaitCheck(
								config,
								prNumber,
								sendProgress,
								"review",
								abortController.signal,
							);
							if (!shouldProceed) {
								debugLog("Review cancelled during CI wait", { reviewKey });
								return;
							}
						}

						// Clean up abort controller since CI wait is done
						ciWaitAbortControllers.delete(reviewKey);

						sendProgress({
							phase: "fetching",
							prNumber,
							progress: 10,
							message: "Fetching PR data...",
						});

						const result = await runPRReview(project, prNumber, mainWindow);

						debugLog("PR review completed", {
							prNumber,
							findingsCount: result.findings.length,
						});
						sendProgress({
							phase: "complete",
							prNumber,
							progress: 100,
							message: "Review complete!",
						});

						sendComplete(result);
					} finally {
						// Clean up in case we exit before runPRReview was called (e.g., cancelled during CI wait)
						// runPRReview also has its own cleanup, but delete is idempotent
						// Only delete if still placeholder (don't delete actual process entry set by runPRReview)
						const entry = runningReviews.get(reviewKey);
						if (entry === CI_WAIT_PLACEHOLDER) {
							runningReviews.delete(reviewKey);
						}
						ciWaitAbortControllers.delete(reviewKey);
					}
				});
			} catch (error) {
				debugLog("PR review failed", {
					prNumber,
					error: error instanceof Error ? error.message : error,
				});
				const { sendError } = createIPCCommunicators<
					PRReviewProgress,
					PRReviewResult
				>(
					mainWindow,
					{
						progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
						error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
						complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
					},
					projectId,
				);
				sendError(
					error instanceof Error ? error.message : "Failed to run PR review",
				);
			}
		},
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
					// Filter findings if selection provided
					const selectedSet = selectedFindingIds
						? new Set(selectedFindingIds)
						: null;
					const findings = selectedSet
						? result.findings.filter((f) => selectedSet.has(f.id))
						: result.findings;

					debugLog("Posting findings", {
						total: result.findings.length,
						selected: findings.length,
					});

					// Build review body - different format for auto-approve with suggestions
					let body: string;

					if (options?.forceApprove) {
						// Auto-approve format: clean approval message with optional suggestions
						body = `## ✅ WorkPilot AI Review - APPROVED\n\n`;
						body += `**Status:** Ready to Merge\n\n`;
						body += `**Summary:** ${result.summary}\n\n`;

						if (findings.length > 0) {
							body += `---\n\n`;
							body += `### 💡 Suggestions (${findings.length})\n\n`;
							body += `*These are non-blocking suggestions for consideration:*\n\n`;

							for (const f of findings) {
								const emoji =
									{ critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" }[
										f.severity
									] || "⚪";
								body += `#### ${emoji} [${f.id}] [${f.severity.toUpperCase()}] ${f.title}\n`;
								body += `📁 \`${f.file}:${f.line}\`\n\n`;
								body += `${f.description}\n\n`;
								const suggestedFix = f.suggestedFix?.trim();
								if (suggestedFix) {
									body += `**Suggested fix:**\n\`\`\`\n${suggestedFix}\n\`\`\`\n\n`;
								}
							}
						}

						body += `---\n*This automated review found no blocking issues. The PR can be safely merged.*\n\n`;
						body += `*Generated by WorkPilot AI*`;
					} else {
						// Standard review format
						body = `## 🤖 WorkPilot AI PR Review\n\n${result.summary}\n\n`;

						if (findings.length > 0) {
							// Show selected count vs total if filtered
							const countText = selectedSet
								? `${findings.length} selected of ${result.findings.length} total`
								: `${findings.length} total`;
							body += `### Findings (${countText})\n\n`;

							for (const f of findings) {
								const emoji =
									{ critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" }[
										f.severity
									] || "⚪";
								body += `#### ${emoji} [${f.id}] [${f.severity.toUpperCase()}] ${f.title}\n`;
								body += `📁 \`${f.file}:${f.line}\`\n\n`;
								body += `${f.description}\n\n`;
								// Only show suggested fix if it has actual content
								const suggestedFix = f.suggestedFix?.trim();
								if (suggestedFix) {
									body += `**Suggested fix:**\n\`\`\`\n${suggestedFix}\n\`\`\`\n\n`;
								}
							}
						} else {
							body += `*No findings selected for this review.*\n\n`;
						}

						body += `---\n*This review was generated by WorkPilot AI.*`;
					}

					// Determine review status based on selected findings (or force approve)
					let overallStatus = result.overallStatus;
					if (options?.forceApprove) {
						// Force approve regardless of findings
						overallStatus = "approve";
					} else if (selectedSet) {
						const hasBlocker = findings.some(
							(f) => f.severity === "critical" || f.severity === "high",
						);
						overallStatus = hasBlocker
							? "request_changes"
							: findings.length > 0
								? "comment"
								: "approve";
					}

					// Map to GitHub API event type
					const event =
						overallStatus === "approve"
							? "APPROVE"
							: overallStatus === "request_changes"
								? "REQUEST_CHANGES"
								: "COMMENT";

					debugLog("Posting review to GitHub", {
						prNumber,
						status: overallStatus,
						event,
						findingsCount: findings.length,
					});

					// Post review via GitHub API to capture review ID
					let reviewId: number;
					try {
						const reviewResponse = (await githubFetch(
							config.token,
							`/repos/${config.repo}/pulls/${prNumber}/reviews`,
							{
								method: "POST",
								body: JSON.stringify({
									body,
									event,
								}),
							},
						)) as { id: number };
						reviewId = reviewResponse.id;
					} catch (error) {
						// GitHub doesn't allow REQUEST_CHANGES or APPROVE on your own PR
						// Fall back to COMMENT if that's the error
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						if (
							errorMsg.includes(
								"Can not request changes on your own pull request",
							) ||
							errorMsg.includes("Can not approve your own pull request")
						) {
							debugLog(
								"Cannot use REQUEST_CHANGES/APPROVE on own PR, falling back to COMMENT",
								{
									prNumber,
								},
							);
							const fallbackResponse = (await githubFetch(
								config.token,
								`/repos/${config.repo}/pulls/${prNumber}/reviews`,
								{
									method: "POST",
									body: JSON.stringify({
										body,
										event: "COMMENT",
									}),
								},
							)) as { id: number };
							reviewId = fallbackResponse.id;
						} else {
							throw error;
						}
					}
					debugLog("Review posted successfully", { prNumber, reviewId });

					// Update the stored review result with the review ID and posted findings
					const reviewPath = path.join(
						getGitHubDir(project),
						"pr",
						`review_${prNumber}.json`,
					);
					try {
						const rawData = fs.readFileSync(reviewPath, "utf-8");
						// Sanitize network data before parsing (review may contain data from GitHub API)
						const sanitizedData = sanitizeNetworkData(rawData);
						const data = JSON.parse(sanitizedData);
						data.review_id = reviewId;
						// Track posted findings to enable follow-up review
						data.has_posted_findings = true;
						const newPostedIds = findings.map((f) => f.id);
						const existingPostedIds = data.posted_finding_ids || [];
						data.posted_finding_ids = [
							...new Set([...existingPostedIds, ...newPostedIds]),
						];
						data.posted_at = new Date().toISOString();
						fs.writeFileSync(
							reviewPath,
							JSON.stringify(data, null, 2),
							"utf-8",
						);
						debugLog(
							"Updated review result with review ID and posted findings",
							{
								prNumber,
								reviewId,
								postedCount: newPostedIds.length,
							},
						);
					} catch {
						// File doesn't exist or couldn't be read - this is expected for new reviews
						debugLog(
							"Review result file not found or unreadable, skipping update",
							{ prNumber },
						);
					}

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
			const result = await withProjectOrNull(projectId, async (project) => {
				try {
					const reviewPath = path.join(
						getGitHubDir(project),
						"pr",
						`review_${prNumber}.json`,
					);

					// Read file directly without separate existence check to avoid TOCTOU race condition
					// If file doesn't exist, readFileSync will throw ENOENT which we handle below
					const rawData = fs.readFileSync(reviewPath, "utf-8");
					// Sanitize data before parsing (review may contain data from GitHub API)
					const sanitizedData = sanitizeNetworkData(rawData);
					const data = JSON.parse(sanitizedData);

					// Mark as posted
					data.has_posted_findings = true;
					data.posted_at = new Date().toISOString();

					fs.writeFileSync(reviewPath, JSON.stringify(data, null, 2), "utf-8");
					debugLog("Marked review as posted", { prNumber });

					return true;
				} catch (error) {
					// Handle file not found (ENOENT) separately for clearer logging
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					) {
						debugLog("Review file not found", { prNumber });
						return false;
					}
					debugLog("Failed to mark review as posted", {
						prNumber,
						error: error instanceof Error ? error.message : error,
					});
					return false;
				}
			});
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
			const postResult = await withProjectOrNull(projectId, async (project) => {
				try {
					const { execFileSync } = await import("node:child_process");
					const { writeFileSync, unlinkSync } = await import("node:fs");
					const { join } = await import("node:path");

					debugLog("Posting comment to PR", { prNumber });

					// Validate prNumber to prevent command injection
					if (!Number.isInteger(prNumber) || prNumber <= 0) {
						throw new Error("Invalid PR number");
					}

					// Use temp file to avoid shell escaping issues
					const tmpFile = join(
						project.path,
						".workpilot",
						"tmp_comment_body.txt",
					);
					try {
						writeFileSync(tmpFile, body, "utf-8");
						// Use execFileSync with arguments array to prevent command injection
						execFileSync(
							"gh",
							["pr", "comment", String(prNumber), "--body-file", tmpFile],
							{
								cwd: project.path,
								env: getAugmentedEnv(),
							},
						);
						unlinkSync(tmpFile);
					} catch (error) {
						try {
							unlinkSync(tmpFile);
						} catch {
							// Ignore cleanup errors
						}
						throw error;
					}

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

						// Clear the review ID from the stored result
						const reviewPath = path.join(
							getGitHubDir(project),
							"pr",
							`review_${prNumber}.json`,
						);
						try {
							const rawData = fs.readFileSync(reviewPath, "utf-8");
							const sanitizedData = sanitizeNetworkData(rawData);
							const data = JSON.parse(sanitizedData);
							delete data.review_id;
							fs.writeFileSync(
								reviewPath,
								JSON.stringify(data, null, 2),
								"utf-8",
							);
							debugLog("Cleared review ID from result file", { prNumber });
						} catch {
							// File doesn't exist or couldn't be read - this is expected if review wasn't saved
							debugLog(
								"Review result file not found or unreadable, skipping update",
								{ prNumber },
							);
						}

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
			const mergeResult = await withProjectOrNull(
				projectId,
				async (project) => {
					try {
						const { execFileSync } = await import("node:child_process");
						debugLog("Merging PR", { prNumber, method: mergeMethod });

						// Validate prNumber to prevent command injection
						if (!Number.isInteger(prNumber) || prNumber <= 0) {
							throw new Error("Invalid PR number");
						}

						// Validate mergeMethod to prevent command injection
						const validMethods = ["merge", "squash", "rebase"];
						if (!validMethods.includes(mergeMethod)) {
							throw new Error("Invalid merge method");
						}

						// Use execFileSync with arguments array to prevent command injection
						execFileSync(
							"gh",
							["pr", "merge", String(prNumber), `--${mergeMethod}`],
							{
								cwd: project.path,
								env: getAugmentedEnv(),
							},
						);
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
			const assignResult = await withProjectOrNull(
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
		async (_, projectId: string, prNumber: number): Promise<boolean> => {
			debugLog("cancelPRReview handler called", { projectId, prNumber });
			const reviewKey = getReviewKey(projectId, prNumber);
			const entry = runningReviews.get(reviewKey);

			if (!entry) {
				debugLog("No running review found to cancel", { reviewKey });
				return false;
			}

			// Handle CI wait placeholder - review is waiting for CI checks
			if (entry === CI_WAIT_PLACEHOLDER) {
				debugLog("Review is in CI wait phase, aborting wait", { reviewKey });
				const abortController = ciWaitAbortControllers.get(reviewKey);
				if (abortController) {
					abortController.abort();
					ciWaitAbortControllers.delete(reviewKey);
				}
				runningReviews.delete(reviewKey);
				debugLog("CI wait cancelled", { reviewKey });
				return true;
			}

			// Handle actual child process
			const childProcess = entry;
			try {
				debugLog("Killing review process", {
					reviewKey,
					pid: childProcess.pid,
				});
				childProcess.kill("SIGTERM");

				// Give it a moment to terminate gracefully, then force kill if needed
				setTimeout(() => {
					if (!childProcess.killed) {
						debugLog("Force killing review process", {
							reviewKey,
							pid: childProcess.pid,
						});
						childProcess.kill("SIGKILL");
					}
				}, 1000);

				// Clean up the registry
				runningReviews.delete(reviewKey);
				debugLog("Review process cancelled", { reviewKey });
				return true;
			} catch (error) {
				debugLog("Failed to cancel review", {
					reviewKey,
					error: error instanceof Error ? error.message : error,
				});
				return false;
			}
		},
	);

	// Check for new commits since last review
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS,
		async (
			_,
			projectId: string,
			prNumber: number,
		): Promise<NewCommitsCheck> => {
			debugLog("checkNewCommits handler called", { projectId, prNumber });

			const result = await withProjectOrNull(projectId, async (project) => {
				// Check if review exists and has reviewed_commit_sha
				const githubDir = path.join(project.path, ".workpilot", "github");
				const reviewPath = path.join(
					githubDir,
					"pr",
					`review_${prNumber}.json`,
				);

				let review: PRReviewResult;
				try {
					const rawData = fs.readFileSync(reviewPath, "utf-8");
					const sanitizedData = sanitizeNetworkData(rawData);
					review = JSON.parse(sanitizedData);
				} catch {
					// File doesn't exist or couldn't be read
					return { hasNewCommits: false, newCommitCount: 0 };
				}

				// Normalize snake_case to camelCase for backwards compatibility with old saved files
				const reviewedCommitSha: string | undefined =
					review.reviewedCommitSha ??
					((review as unknown as Record<string, unknown>).reviewed_commit_sha as
						| string
						| undefined);
				if (!reviewedCommitSha) {
					debugLog("No reviewedCommitSha in review", { prNumber });
					return { hasNewCommits: false, newCommitCount: 0 };
				}

				// Get current PR HEAD
				const config = getGitHubConfig(project);
				if (!config) {
					return { hasNewCommits: false, newCommitCount: 0 };
				}

				// Fetch PR data to get current HEAD (before try block so it's accessible in catch)
				let currentHeadSha: string;
				try {
					const prData = (await githubFetch(
						config.token,
						`/repos/${config.repo}/pulls/${prNumber}`,
					)) as { head: { sha: string }; commits: number };
					currentHeadSha = prData.head.sha;
				} catch (error) {
					debugLog("Error fetching PR data", {
						prNumber,
						error: error instanceof Error ? error.message : error,
					});
					return { hasNewCommits: false, newCommitCount: 0 };
				}

				// Early return if SHAs match - no new commits
				if (reviewedCommitSha === currentHeadSha) {
					return {
						hasNewCommits: false,
						newCommitCount: 0,
						lastReviewedCommit: reviewedCommitSha,
						currentHeadCommit: currentHeadSha,
						hasCommitsAfterPosting: false,
					};
				}

				// Try to get detailed comparison
				try {
					// Get comparison to count new commits and see what files changed
					const comparison = (await githubFetch(
						config.token,
						`/repos/${config.repo}/compare/${reviewedCommitSha}...${currentHeadSha}`,
					)) as {
						ahead_by?: number;
						total_commits?: number;
						commits?: Array<{
							commit: { committer: { date: string }; message: string };
							parents?: Array<{ sha: string }>;
						}>;
						files?: Array<{ filename: string }>;
					};

					// Check if findings have been posted and if new commits are after the posting date
					// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
					const postedAt = review.postedAt || (review as any).posted_at;
					let hasCommitsAfterPosting = true; // Default to true if we can't determine

					if (postedAt && comparison.commits && comparison.commits.length > 0) {
						const postedAtDate = new Date(postedAt);
						// Check if any commit is newer than when findings were posted
						hasCommitsAfterPosting = comparison.commits.some((c) => {
							const commitDate = new Date(c.commit.committer.date);
							return commitDate > postedAtDate;
						});
						debugLog("Comparing commit dates with posted_at", {
							prNumber,
							postedAt,
							latestCommitDate:
								comparison.commits[comparison.commits.length - 1]?.commit
									.committer.date,
							hasCommitsAfterPosting,
						});
					} else if (!postedAt) {
						// If findings haven't been posted yet, we can't determine "after posting"
						// Follow-up should only be available after initial review is posted to GitHub
						hasCommitsAfterPosting = false;
					}

					// Check if this looks like a merge from base branch (develop/main)
					// Merge commits always have 2+ parents, so we check for that AND a merge-like message
					// Pattern matches: "Merge branch", "Merge pull request", "Merge remote-tracking",
					// "Merge 'develop' into", "Merge develop into", GitHub's "Update branch" button, etc.
					const isMergeFromBase =
						comparison.commits?.some((c) => {
							const hasTwoParents = (c.parents?.length ?? 0) >= 2;
							const isMergeMessage = /^merge\s+/i.test(c.commit.message);
							return hasTwoParents && isMergeMessage;
						}) ?? false;

					// Get files that had findings from the review
					const findingFiles = new Set<string>(
						(review.findings || []).map((f) => f.file).filter(Boolean),
					);

					// Get files changed in the new commits
					const newCommitFiles = (comparison.files || []).map(
						(f) => f.filename,
					);

					// Check for overlap between new commit files and finding files
					const overlappingFiles = newCommitFiles.filter((f) =>
						findingFiles.has(f),
					);
					const hasOverlapWithFindings = overlappingFiles.length > 0;

					debugLog("File overlap check", {
						prNumber,
						findingFilesCount: findingFiles.size,
						newCommitFilesCount: newCommitFiles.length,
						overlappingFiles,
						hasOverlapWithFindings,
						isMergeFromBase,
					});

					return {
						hasNewCommits: true,
						newCommitCount:
							comparison.ahead_by || comparison.total_commits || 1,
						lastReviewedCommit: reviewedCommitSha,
						currentHeadCommit: currentHeadSha,
						hasCommitsAfterPosting,
						hasOverlapWithFindings,
						overlappingFiles:
							overlappingFiles.length > 0 ? overlappingFiles : undefined,
						isMergeFromBase,
					};
				} catch (error) {
					// Comparison failed (e.g., force push made old commit unreachable)
					// Since we already verified SHAs differ, treat as having new commits
					debugLog(
						"Comparison failed but SHAs differ - likely force push, treating as new commits",
						{
							prNumber,
							reviewedCommitSha,
							currentHeadSha,
							error: error instanceof Error ? error.message : error,
						},
					);
					// Note: hasOverlapWithFindings, overlappingFiles, isMergeFromBase intentionally omitted
					// since we can't determine them without the comparison API. UI defaults to safe behavior
					// (hasOverlapWithFindings ?? true) which prompts user to verify.
					return {
						hasNewCommits: true,
						newCommitCount: 1, // Unknown count due to force push
						lastReviewedCommit: reviewedCommitSha,
						currentHeadCommit: currentHeadSha,
						hasCommitsAfterPosting: true, // Assume yes for force push scenarios
					};
				}
			});

			return result ?? { hasNewCommits: false, newCommitCount: 0 };
		},
	);

	// Check merge readiness (lightweight freshness check for verdict validation)
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS,
		async (_, projectId: string, prNumber: number): Promise<MergeReadiness> => {
			debugLog("checkMergeReadiness handler called", { projectId, prNumber });

			const defaultResult: MergeReadiness = {
				isDraft: false,
				mergeable: "UNKNOWN",
				isBehind: false,
				ciStatus: "none",
				blockers: [],
			};

			const result = await withProjectOrNull(projectId, async (project) => {
				const config = getGitHubConfig(project);
				if (!config) {
					debugLog("No GitHub config found for checkMergeReadiness");
					return defaultResult;
				}

				try {
					// Fetch PR data including mergeable status
					const pr = (await githubFetch(
						config.token,
						`/repos/${config.repo}/pulls/${prNumber}`,
					)) as {
						draft: boolean;
						mergeable: boolean | null;
						mergeable_state: string;
						head: { sha: string };
					};

					// Determine mergeable status
					let mergeable: MergeReadiness["mergeable"] = "UNKNOWN";
					if (pr.mergeable === true) {
						mergeable = "MERGEABLE";
					} else if (pr.mergeable === false || pr.mergeable_state === "dirty") {
						mergeable = "CONFLICTING";
					}

					// Check if branch is behind base (out of date)
					// GitHub's mergeable_state can be: 'behind', 'blocked', 'clean', 'dirty', 'has_hooks', 'unknown', 'unstable'
					const isBehind = pr.mergeable_state === "behind";

					// Fetch combined commit status for CI
					let ciStatus: MergeReadiness["ciStatus"] = "none";
					try {
						const status = (await githubFetch(
							config.token,
							`/repos/${config.repo}/commits/${pr.head.sha}/status`,
						)) as {
							state: "success" | "pending" | "failure" | "error";
							total_count: number;
						};

						if (status.total_count === 0) {
							// No status checks, check for check runs (GitHub Actions)
							const checkRuns = (await githubFetch(
								config.token,
								`/repos/${config.repo}/commits/${pr.head.sha}/check-runs`,
							)) as {
								total_count: number;
								check_runs: Array<{
									conclusion: string | null;
									status: string;
								}>;
							};

							if (checkRuns.total_count > 0) {
								const hasFailing = checkRuns.check_runs.some(
									(cr) =>
										cr.conclusion === "failure" ||
										cr.conclusion === "cancelled",
								);
								const hasPending = checkRuns.check_runs.some(
									(cr) => cr.status !== "completed",
								);

								if (hasFailing) {
									ciStatus = "failing";
								} else if (hasPending) {
									ciStatus = "pending";
								} else {
									ciStatus = "passing";
								}
							}
						} else {
							// Use combined status
							if (status.state === "success") {
								ciStatus = "passing";
							} else if (status.state === "pending") {
								ciStatus = "pending";
							} else {
								ciStatus = "failing";
							}
						}
					} catch (err) {
						debugLog("Failed to fetch CI status", {
							prNumber,
							error: err instanceof Error ? err.message : err,
						});
						// Continue without CI status
					}

					// Build blockers list
					const blockers: string[] = [];
					if (pr.draft) {
						blockers.push("PR is in draft mode");
					}
					if (mergeable === "CONFLICTING") {
						blockers.push("Merge conflicts detected");
					}
					if (isBehind) {
						blockers.push(
							"Branch is out of date with base branch. Update to check for conflicts.",
						);
					}
					if (ciStatus === "failing") {
						blockers.push("CI checks are failing");
					}

					debugLog("checkMergeReadiness result", {
						prNumber,
						isDraft: pr.draft,
						mergeable,
						isBehind,
						ciStatus,
						blockers,
					});

					return {
						isDraft: pr.draft,
						mergeable,
						isBehind,
						ciStatus,
						blockers,
					};
				} catch (error) {
					debugLog("Failed to check merge readiness", {
						prNumber,
						error: error instanceof Error ? error.message : error,
					});
					return defaultResult;
				}
			});

			return result ?? defaultResult;
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

			const updateResult = await withProjectOrNull(
				projectId,
				async (project) => {
					try {
						const { execFile } = await import("node:child_process");
						const { promisify } = await import("node:util");
						const execFileAsync = promisify(execFile);
						debugLog("Updating PR branch", { prNumber });

						// Validate prNumber to prevent command injection
						if (!Number.isInteger(prNumber) || prNumber <= 0) {
							throw new Error("Invalid PR number");
						}

						// Use gh pr update-branch to sync with base branch (async to avoid blocking main process)
						// --rebase is not used to avoid force-push requirements
						await execFileAsync(
							"gh",
							["pr", "update-branch", String(prNumber)],
							{
								cwd: project.path,
								env: getAugmentedEnv(),
							},
						);

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

	// Run follow-up review
	ipcMain.on(
		IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW,
		async (_, projectId: string, prNumber: number) => {
			debugLog("followupReview handler called", { projectId, prNumber });
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				debugLog("No main window available");
				return;
			}

			try {
				await withProjectOrNull(projectId, async (project) => {
					const { sendProgress, sendError, sendComplete } =
						createIPCCommunicators<PRReviewProgress, PRReviewResult>(
							mainWindow,
							{
								progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
								error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
								complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
							},
							projectId,
						);

					// Comprehensive validation of GitHub module
					const validation = await validateGitHubModule(project);
					if (!validation.valid) {
						sendError({
							prNumber,
							error: validation.error || "GitHub module validation failed",
						});
						return;
					}

					// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
					const backendPath = validation.backendPath!;
					const reviewKey = getReviewKey(projectId, prNumber);

					// Check if already running
					if (runningReviews.has(reviewKey)) {
						debugLog("Follow-up review already running", { reviewKey });
						return;
					}

					// Register as running BEFORE CI wait to prevent race conditions
					// Use CI_WAIT_PLACEHOLDER sentinel until real process is spawned
					runningReviews.set(reviewKey, CI_WAIT_PLACEHOLDER);
					const abortController = new AbortController();
					ciWaitAbortControllers.set(reviewKey, abortController);
					debugLog("Registered follow-up review placeholder", { reviewKey });

					try {
						debugLog("Starting follow-up review", { prNumber });
						sendProgress({
							phase: "fetching",
							prNumber,
							progress: 5,
							message: "Starting follow-up review...",
						});

						// Wait for CI checks to complete before starting follow-up review
						const config = getGitHubConfig(project);
						if (config) {
							const shouldProceed = await performCIWaitCheck(
								config,
								prNumber,
								sendProgress,
								"follow-up review",
								abortController.signal,
							);
							if (!shouldProceed) {
								debugLog("Follow-up review cancelled during CI wait", {
									reviewKey,
								});
								return;
							}
						}

						// Clean up abort controller since CI wait is done
						ciWaitAbortControllers.delete(reviewKey);

						const { model, thinkingLevel } = getGitHubPRSettings();
						const args = buildRunnerArgs(
							getRunnerPath(backendPath),
							project.path,
							"followup-review-pr",
							[prNumber.toString()],
							{ model, thinkingLevel },
						);

						debugLog("Spawning follow-up review process", {
							args,
							model,
							thinkingLevel,
						});

						// Create log collector for this follow-up review (config already declared above)
						const repo = config?.repo || project.name || "unknown";
						const logCollector = new PRLogCollector(
							project,
							prNumber,
							repo,
							true,
						);

						// Build environment with project settings
						const followupEnv = await getRunnerEnv(getClaudeMdEnv(project), {
							jevWorkflow: "github-review",
							page: "github-prs",
						});

						const { process: childProcess, promise } =
							runPythonSubprocess<PRReviewResult>({
								pythonPath: getPythonPath(backendPath),
								args,
								cwd: backendPath,
								env: followupEnv,
								onProgress: (percent, message) => {
									debugLog("Progress update", { percent, message });
									sendProgress({
										phase: "analyzing",
										prNumber,
										progress: percent,
										message,
									});
								},
								onStdout: (line) => {
									debugLog("STDOUT:", line);
									// Collect log entries
									logCollector.processLine(line);
								},
								onStderr: (line) => debugLog("STDERR:", line),
								onAuthFailure: (authFailureInfo: AuthFailureInfo) => {
									// Send auth failure to renderer to show modal
									debugLog(
										"Auth failure detected in follow-up PR review",
										authFailureInfo,
									);
									mainWindow.webContents.send(
										IPC_CHANNELS.CLAUDE_AUTH_FAILURE,
										authFailureInfo,
									);
								},
								onComplete: () => {
									// Load the result from disk
									const reviewResult = getReviewResult(project, prNumber);
									if (!reviewResult) {
										throw new Error(
											"Follow-up review completed but result not found",
										);
									}
									debugLog("Follow-up review result loaded", {
										findingsCount: reviewResult.findings.length,
									});
									return reviewResult;
								},
								// Register with OperationRegistry for proactive swap support
								operationRegistration: {
									operationId: `pr-followup-review:${reviewKey}`,
									operationType: "pr-review",
									metadata: {
										projectId: project.id,
										prNumber,
										repo,
										isFollowup: true,
									},
								},
							});

						// Update registry with actual process (replacing placeholder)
						runningReviews.set(reviewKey, childProcess);
						debugLog("Registered follow-up review process", {
							reviewKey,
							pid: childProcess.pid,
						});

						const result = await promise;

						if (!result.success) {
							// Finalize logs with failure
							logCollector.finalize(false);
							throw new Error(result.error ?? "Follow-up review failed");
						}

						// Finalize logs with success
						logCollector.finalize(true);

						debugLog("Follow-up review completed", {
							prNumber,
							findingsCount: result.data?.findings.length,
						});
						sendProgress({
							phase: "complete",
							prNumber,
							progress: 100,
							message: "Follow-up review complete!",
						});

						// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
						sendComplete(result.data!);
					} finally {
						// Always clean up registry, whether we exit normally or via error
						runningReviews.delete(reviewKey);
						ciWaitAbortControllers.delete(reviewKey);
						debugLog("Unregistered follow-up review process", { reviewKey });
					}
				});
			} catch (error) {
				debugLog("Follow-up review failed", {
					prNumber,
					error: error instanceof Error ? error.message : error,
				});
				const { sendError } = createIPCCommunicators<
					PRReviewProgress,
					PRReviewResult
				>(
					mainWindow,
					{
						progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
						error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
						complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
					},
					projectId,
				);
				sendError({
					prNumber,
					error:
						error instanceof Error
							? error.message
							: "Failed to run follow-up review",
				});
			}
		},
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
			const result = await withProjectOrNull(projectId, async (project) => {
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
			const result = await withProjectOrNull(projectId, async (project) => {
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
		async (
			_,
			projectId: string,
			limit: number = 10,
		): Promise<PRReviewMemory[]> => {
			debugLog("getPRReviewMemories handler called", { projectId, limit });
			const result = await withProjectOrNull(projectId, async (project) => {
				const memoryDir = path.join(
					getGitHubDir(project),
					"memory",
					project.name || "unknown",
				);
				const memories: PRReviewMemory[] = [];

				// Try to load from file-based storage
				try {
					const indexPath = path.join(memoryDir, "reviews_index.json");
					if (!fs.existsSync(indexPath)) {
						debugLog("No PR review memories found", { projectId });
						return [];
					}

					const indexContent = fs.readFileSync(indexPath, "utf-8");
					const index = JSON.parse(sanitizeNetworkData(indexContent));
					const reviews = index.reviews || [];

					// Load individual review memories
					for (const entry of reviews.slice(0, limit)) {
						try {
							const reviewPath = path.join(
								memoryDir,
								`pr_${entry.pr_number}_review.json`,
							);
							if (fs.existsSync(reviewPath)) {
								const reviewContent = fs.readFileSync(reviewPath, "utf-8");
								const memory = JSON.parse(sanitizeNetworkData(reviewContent));
								memories.push({
									prNumber: memory.pr_number,
									repo: memory.repo,
									verdict: memory.summary?.verdict || "unknown",
									timestamp: memory.timestamp,
									summary: memory.summary,
									keyFindings: memory.key_findings || [],
									patterns: memory.patterns || [],
									gotchas: memory.gotchas || [],
									isFollowup: memory.is_followup || false,
								});
							}
						} catch (err) {
							debugLog("Failed to load PR review memory", {
								prNumber: entry.pr_number,
								error: err instanceof Error ? err.message : err,
							});
						}
					}

					debugLog("Loaded PR review memories", { count: memories.length });
					return memories;
				} catch (error) {
					debugLog("Failed to load PR review memories", {
						error: error instanceof Error ? error.message : error,
					});
					return [];
				}
			});
			return result ?? [];
		},
	);

	// Search PR review memories
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_MEMORY_SEARCH,
		async (
			_,
			projectId: string,
			query: string,
			limit: number = 10,
		): Promise<PRReviewMemory[]> => {
			debugLog("searchPRReviewMemories handler called", {
				projectId,
				query,
				limit,
			});
			const result = await withProjectOrNull(projectId, async (project) => {
				const memoryDir = path.join(
					getGitHubDir(project),
					"memory",
					project.name || "unknown",
				);
				const memories: PRReviewMemory[] = [];
				const queryLower = query.toLowerCase();

				// Search through file-based storage
				try {
					const indexPath = path.join(memoryDir, "reviews_index.json");
					if (!fs.existsSync(indexPath)) {
						return [];
					}

					const indexContent = fs.readFileSync(indexPath, "utf-8");
					const index = JSON.parse(sanitizeNetworkData(indexContent));
					const reviews = index.reviews || [];

					// Search individual review memories
					for (const entry of reviews) {
						try {
							const reviewPath = path.join(
								memoryDir,
								`pr_${entry.pr_number}_review.json`,
							);
							if (fs.existsSync(reviewPath)) {
								const reviewContent = fs.readFileSync(reviewPath, "utf-8");

								// Check if content matches query
								if (reviewContent.toLowerCase().includes(queryLower)) {
									const memory = JSON.parse(sanitizeNetworkData(reviewContent));
									memories.push({
										prNumber: memory.pr_number,
										repo: memory.repo,
										verdict: memory.summary?.verdict || "unknown",
										timestamp: memory.timestamp,
										summary: memory.summary,
										keyFindings: memory.key_findings || [],
										patterns: memory.patterns || [],
										gotchas: memory.gotchas || [],
										isFollowup: memory.is_followup || false,
									});
								}
							}

							// Stop if we have enough
							if (memories.length >= limit) {
								break;
							}
						} catch (err) {
							debugLog("Failed to search PR review memory", {
								prNumber: entry.pr_number,
								error: err instanceof Error ? err.message : err,
							});
						}
					}

					debugLog("Found matching PR review memories", {
						count: memories.length,
						query,
					});
					return memories;
				} catch (error) {
					debugLog("Failed to search PR review memories", {
						error: error instanceof Error ? error.message : error,
					});
					return [];
				}
			});
			return result ?? [];
		},
	);

	debugLog("PR handlers registered");
}
