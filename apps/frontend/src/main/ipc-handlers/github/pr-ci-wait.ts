/**
 * Waiting for a pull request's CI checks before a review starts. Split out of
 * pr-handlers.ts (audit lot L11, F36).
 */

import { githubFetch } from "./utils";
import { createContextLogger } from "./utils/logger";

// Same context as pr-handlers.ts: these lines were logged from there.
const { debug: debugLog } = createContextLogger("GitHub PR");

/**
 * PR review progress status
 */
export interface PRReviewProgress {
	phase: "fetching" | "analyzing" | "generating" | "posting" | "complete";
	prNumber: number;
	progress: number;
	message: string;
}

/**
 * Result of waiting for CI checks to complete
 */
export interface CIWaitResult {
	/** Whether we successfully waited (no timeout) */
	success: boolean;
	/** Whether any checks are still pending (queued or in_progress) */
	hasInProgress: boolean;
	/** Number of checks currently pending (queued or in_progress) */
	inProgressCount: number;
	/** Names of checks still pending (if any) */
	inProgressChecks: string[];
	/** Whether we timed out waiting */
	timedOut: boolean;
	/** Total wait time in seconds */
	waitTimeSeconds: number;
}

/**
 * Wait for CI checks to complete before starting AI review.
 *
 * Polls GitHub API to check if any CI checks are "queued" or "in_progress".
 * Blocks on BOTH statuses because:
 * - "queued" = CI has been triggered but not started yet
 * - "in_progress" = CI is actively running
 *
 * We wait for all checks to reach "completed" status before reviewing,
 * so our review doesn't report "CI is pending" when it will finish soon.
 *
 * @param token GitHub API token
 * @param repo Repository in "owner/repo" format
 * @param headSha The commit SHA to check CI status for
 * @param prNumber PR number (for progress updates)
 * @param sendProgress Callback to send progress updates to frontend
 * @param abortSignal Optional abort signal for cancellation support
 * @returns CIWaitResult with final CI status
 */
export async function waitForCIChecks(
	token: string,
	repo: string,
	headSha: string,
	prNumber: number,
	sendProgress: (progress: PRReviewProgress) => void,
	abortSignal?: AbortSignal,
): Promise<CIWaitResult> {
	const POLL_INTERVAL_MS = 20000; // 20 seconds
	const MAX_WAIT_MINUTES = 30;
	const MAX_WAIT_MS = MAX_WAIT_MINUTES * 60 * 1000; // 30 minutes
	const MAX_ITERATIONS = Math.floor(MAX_WAIT_MS / POLL_INTERVAL_MS); // 90 iterations

	let iteration = 0;
	const startTime = Date.now();
	// Track last known in-progress state for accurate timeout reporting
	let lastInProgressCount = 0;
	let lastInProgressNames: string[] = [];

	debugLog("Starting CI wait check", {
		prNumber,
		headSha,
		maxIterations: MAX_ITERATIONS,
	});

	while (iteration < MAX_ITERATIONS) {
		// Check for cancellation
		if (abortSignal?.aborted) {
			debugLog("CI wait cancelled by user", { prNumber, iteration });
			return {
				success: false,
				hasInProgress: lastInProgressCount > 0,
				inProgressCount: lastInProgressCount,
				inProgressChecks: lastInProgressNames,
				timedOut: false,
				waitTimeSeconds: Math.floor((Date.now() - startTime) / 1000),
			};
		}

		try {
			// Fetch check runs for the commit
			const checkRuns = (await githubFetch(
				token,
				`/repos/${repo}/commits/${headSha}/check-runs`,
			)) as {
				total_count: number;
				check_runs: Array<{
					name: string;
					status: "queued" | "in_progress" | "completed";
					conclusion: string | null;
				}>;
			};

			// Find checks that are not yet completed (queued or in_progress)
			// We block on BOTH statuses to ensure CI is fully done before reviewing
			const inProgressChecks = checkRuns.check_runs.filter(
				(cr) => cr.status === "queued" || cr.status === "in_progress",
			);

			const inProgressCount = inProgressChecks.length;
			const inProgressNames = inProgressChecks.map((cr) => cr.name);

			// Track last known state for timeout reporting
			lastInProgressCount = inProgressCount;
			lastInProgressNames = inProgressNames;

			debugLog("CI check status", {
				prNumber,
				iteration,
				totalChecks: checkRuns.total_count,
				inProgressCount,
				inProgressNames,
			});

			// If no checks are pending (queued or in_progress), we can proceed
			if (inProgressCount === 0) {
				const waitTimeSeconds = Math.floor((Date.now() - startTime) / 1000);
				debugLog("All CI checks completed, proceeding with review", {
					prNumber,
					waitTimeSeconds,
				});

				return {
					success: true,
					hasInProgress: false,
					inProgressCount: 0,
					inProgressChecks: [],
					timedOut: false,
					waitTimeSeconds,
				};
			}

			// Checks are still running - send progress update and wait
			iteration++;
			const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
			const remainingMinutes = MAX_WAIT_MINUTES - elapsedMinutes;

			const checkNames =
				inProgressNames.length <= 3
					? inProgressNames.join(", ")
					: `${inProgressNames.slice(0, 3).join(", ")} and ${inProgressNames.length - 3} more`;

			sendProgress({
				phase: "fetching",
				prNumber,
				progress: 5, // Keep progress low during wait
				message: `Waiting for CI checks to complete (${checkNames})... ${remainingMinutes}m remaining`,
			});

			debugLog("Waiting for CI checks", {
				prNumber,
				iteration,
				inProgressCount,
				elapsedMinutes,
				remainingMinutes,
			});

			// Wait before next poll (with abort check)
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

			// Check for cancellation after wait
			if (abortSignal?.aborted) {
				debugLog("CI wait cancelled by user during poll interval", {
					prNumber,
					iteration,
				});
				return {
					success: false,
					hasInProgress: lastInProgressCount > 0,
					inProgressCount: lastInProgressCount,
					inProgressChecks: lastInProgressNames,
					timedOut: false,
					waitTimeSeconds: Math.floor((Date.now() - startTime) / 1000),
				};
			}
		} catch (error) {
			// If we fail to fetch CI status, log and continue with the review
			// This prevents CI check failures from blocking reviews entirely
			debugLog("Failed to fetch CI status, proceeding with review", {
				prNumber,
				error: error instanceof Error ? error.message : error,
			});

			return {
				success: true,
				hasInProgress: false, // Assume no in-progress on error
				inProgressCount: 0,
				inProgressChecks: [],
				timedOut: false,
				waitTimeSeconds: Math.floor((Date.now() - startTime) / 1000),
			};
		}
	}

	// Timed out waiting for CI checks
	const waitTimeSeconds = Math.floor((Date.now() - startTime) / 1000);
	debugLog("CI wait timed out, proceeding with review anyway", {
		prNumber,
		waitTimeSeconds,
		maxWaitSeconds: MAX_WAIT_MS / 1000,
		lastInProgressCount,
		lastInProgressNames,
	});

	return {
		success: false,
		hasInProgress: true,
		inProgressCount: lastInProgressCount,
		inProgressChecks: lastInProgressNames,
		timedOut: true,
		waitTimeSeconds,
	};
}

/**
 * Perform CI wait check before starting a PR review.
 *
 * Encapsulates the common logic for waiting on CI checks, including:
 * - Fetching the PR head SHA
 * - Calling waitForCIChecks
 * - Logging the result
 *
 * @param config GitHub config with token and repo
 * @param prNumber PR number
 * @param sendProgress Progress callback
 * @param reviewType Type of review for logging ("review" or "follow-up review")
 * @param abortSignal Optional abort signal for cancellation support
 * @returns true if the review should proceed, false if cancelled
 */
export async function performCIWaitCheck(
	config: { token: string; repo: string },
	prNumber: number,
	sendProgress: (progress: PRReviewProgress) => void,
	reviewType: "review" | "follow-up review",
	abortSignal?: AbortSignal,
): Promise<boolean> {
	try {
		sendProgress({
			phase: "fetching",
			prNumber,
			progress: 5,
			message: "Checking CI status...",
		});

		// Get PR head SHA for CI status check
		const pr = (await githubFetch(
			config.token,
			`/repos/${config.repo}/pulls/${prNumber}`,
		)) as { head: { sha: string } };

		const ciWaitResult = await waitForCIChecks(
			config.token,
			config.repo,
			pr.head.sha,
			prNumber,
			sendProgress,
			abortSignal,
		);

		// Check if cancelled
		if (
			abortSignal?.aborted ||
			(!ciWaitResult.success && !ciWaitResult.timedOut)
		) {
			debugLog(`CI wait cancelled, aborting ${reviewType}`, { prNumber });
			return false;
		}

		if (ciWaitResult.timedOut) {
			debugLog(`CI wait timed out, proceeding with ${reviewType}`, {
				prNumber,
				waitTimeSeconds: ciWaitResult.waitTimeSeconds,
			});
		} else if (ciWaitResult.waitTimeSeconds > 0) {
			debugLog(`CI checks completed, starting ${reviewType}`, {
				prNumber,
				waitTimeSeconds: ciWaitResult.waitTimeSeconds,
			});
		}
		return true;
	} catch (ciError) {
		// Don't fail the review if CI check fails, just log and proceed
		debugLog(`Failed to check CI status, proceeding with ${reviewType}`, {
			prNumber,
			error: ciError instanceof Error ? ciError.message : ciError,
		});
		return true;
	}
}
