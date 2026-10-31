/**
 * The AI review of a server project's pull requests (server mode).
 *
 * A local project's review runs the GitHub runner on this computer, in the
 * project's folder. A server project has no folder here: its review runs on
 * the server, as a job on the project's clone with the GitHub token of whoever
 * starts it (`shared_features/github_review.py`). The app follows the job like
 * a local process (`relayServerJob`), reads the saved reviews from the server,
 * and records there what the person posted, so every member sees the same
 * review.
 */

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { Project } from "../../../shared/types";
import { authedFetch } from "../../server-connection";
import { relayServerJob } from "../../server-features";
import { featureProject } from "../server-feature-files";
import type { PRReviewProgress } from "./pr-ci-wait";
import { postReviewToGitHub } from "./pr-review-post";
import { type PRReviewResult, reviewFromJson } from "./review-result";
import { serverGitHubConfig } from "./server-relay";
import { createIPCCommunicators } from "./utils/ipc-communicator";

const ROUTE = "/api/features/forge/github/reviews";
const FEATURE = "forge/github/reviews";
/** As many reviews as the server serves in one read. */
const READ_MAX = 50;
const PROGRESS = /\[\s*(\d+)%\]\s*(.+)/;

/** The reviews running on the server, by `<project>:<pr>`. */
const running = new Map<string, { kill(): boolean }>();

/** A server project, by id; undefined for a local one. */
export function serverProjectOf(projectId: unknown): Project | undefined {
	const project = featureProject(projectId);
	return project?.remote ? project : undefined;
}

function isPRNumber(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0;
}

function query(project: Project): string {
	return `project_id=${encodeURIComponent(project.id)}`;
}

/** The saved reviews of these pull requests, from the server. */
export async function serverReviews(
	project: Project,
	prNumbers: readonly unknown[],
): Promise<Record<number, PRReviewResult | null>> {
	const numbers = [...new Set(prNumbers.filter(isPRNumber))];
	const reviews: Record<number, PRReviewResult | null> = {};
	for (let at = 0; at < numbers.length; at += READ_MAX) {
		const part = numbers.slice(at, at + READ_MAX);
		const result = await authedFetch<{ reviews?: Record<string, unknown> }>(
			`${ROUTE}?numbers=${part.join(",")}&${query(project)}`,
			"GET",
		);
		const saved = result.ok ? (result.data?.reviews ?? {}) : {};
		for (const prNumber of part) {
			const text = saved[String(prNumber)];
			try {
				reviews[prNumber] = typeof text === "string" ? reviewFromJson(text) : null;
			} catch {
				reviews[prNumber] = null;
			}
		}
	}
	return reviews;
}

/** Record on the server what the person posted of a review. */
export async function markServerReviewPosted(
	project: Project,
	prNumber: number,
	posted: { findingIds?: string[]; reviewId?: number } = {},
): Promise<boolean> {
	if (!isPRNumber(prNumber)) return false;
	const result = await authedFetch(
		`${ROUTE}/${prNumber}/posted?${query(project)}`,
		"POST",
		{
			finding_ids: posted.findingIds ?? [],
			...(isPRNumber(posted.reviewId) ? { review_id: posted.reviewId } : {}),
		},
	);
	return result.ok;
}

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
	const review = isPRNumber(prNumber)
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

/**
 * Review a pull request on the server and tell the view, as a local review
 * does: progress while it runs, then the saved review or the error.
 */
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
	if (!isPRNumber(prNumber)) {
		sendError("Not a pull request number");
		return;
	}
	const key = `${project.id}:${prNumber}`;
	if (running.has(key)) return;
	sendProgress({
		phase: "fetching",
		prNumber,
		progress: 5,
		message: "Starting the review on the server...",
	});
	const thinking = ["none", "low", "medium", "high"].includes(settings.thinkingLevel)
		? { thinking_level: settings.thinkingLevel }
		: {};
	const job = relayServerJob(project, FEATURE, {
		options: { pr_number: prNumber, followup, model: settings.model, ...thinking },
	});
	running.set(key, job);
	const errors: string[] = [];
	job.stdout.on("data", (data: Buffer) => {
		for (const line of data.toString("utf-8").split("\n")) {
			const match = PROGRESS.exec(line);
			if (match) {
				sendProgress({
					phase: "analyzing",
					prNumber,
					progress: Number.parseInt(match[1], 10),
					message: match[2].trim(),
				});
			}
		}
	});
	job.stderr.on("data", (data: Buffer) => {
		errors.push(data.toString("utf-8").trim());
	});
	job.on("exit", (code: number | null) => {
		running.delete(key);
		if (code === null) return; // cancelled
		if (code !== 0) {
			sendError(errors.filter(Boolean).join("\n") || "The review failed on the server");
			return;
		}
		void serverReviews(project, [prNumber]).then(
			(reviews) => {
				const review = reviews[prNumber];
				if (!review) {
					sendError("Review completed but result not found");
					return;
				}
				sendProgress({
					phase: "complete",
					prNumber,
					progress: 100,
					message: "Review complete!",
				});
				sendComplete(review);
			},
			(error: unknown) =>
				sendError(error instanceof Error ? error.message : String(error)),
		);
	});
}

/** Stop a review running on the server; false when none runs from here. */
export function cancelServerReview(projectId: string, prNumber: number): boolean {
	const job = running.get(`${projectId}:${prNumber}`);
	if (!job) return false;
	running.delete(`${projectId}:${prNumber}`);
	return job.kill();
}
