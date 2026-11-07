/**
 * The AI review of a server project's pull or merge requests (server mode).
 *
 * A local project's review runs the forge's runner on this computer, in the
 * project's folder. A server project has no folder here: its review runs on
 * the server, as a job on the project's clone with the forge token of whoever
 * starts it (`shared_features/forge_review.py`). The app follows the job like
 * a local process (`relayServerJob`), reads the saved reviews from the server,
 * and records there what the person posted, so every member sees the same
 * review. The GitHub view (`github/server-pr-review.ts`) and the GitLab view
 * (`gitlab/server-mr-review.ts`) tell their own channels.
 */

import type { Project } from "../../shared/types";
import { authedFetch } from "../server-connection";
import { relayServerJob } from "../server-features";
import { featureProject } from "./server-feature-files";

/** As many reviews as the server serves in one read. */
const READ_MAX = 50;
const PROGRESS = /\[\s*(\d+)%\]\s*(.+)/;
const THINKING = new Set(["none", "low", "medium", "high"]);

/** A server project, by id; undefined for a local one. */
export function serverProjectOf(projectId: unknown): Project | undefined {
	const project = featureProject(projectId);
	return project?.remote ? project : undefined;
}

/** A pull request number or a merge request IID. */
export function isRequestNumber(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0;
}

function query(project: Project): string {
	return `project_id=${encodeURIComponent(project.id)}`;
}

/** What a review tells its view while it runs. */
export interface ReviewListener<R> {
	progress(phase: "fetching" | "analyzing" | "complete", progress: number, message: string): void;
	complete(review: R): void;
	error(message: string): void;
}

/** The reviews of one forge on the server, its saved results read by `parse`. */
export function serverReviewJobs<R>(
	forge: "github" | "gitlab",
	parse: (text: string) => R,
) {
	const route = `/api/features/forge/${forge}/reviews`;
	/** The reviews running on the server, by `<project>:<number>`. */
	const running = new Map<string, { kill(): boolean }>();

	/** The saved reviews of these requests, from the server. */
	async function reviews(
		project: Project,
		numbers: readonly unknown[],
	): Promise<Record<number, R | null>> {
		const wanted = [...new Set(numbers.filter(isRequestNumber))];
		const found: Record<number, R | null> = {};
		for (let at = 0; at < wanted.length; at += READ_MAX) {
			const part = wanted.slice(at, at + READ_MAX);
			const result = await authedFetch<{ reviews?: Record<string, unknown> }>(
				`${route}?numbers=${part.join(",")}&${query(project)}`,
				"GET",
			);
			const saved = result.ok ? (result.data?.reviews ?? {}) : {};
			for (const number of part) {
				const text = saved[String(number)];
				try {
					found[number] = typeof text === "string" ? parse(text) : null;
				} catch {
					found[number] = null;
				}
			}
		}
		return found;
	}

	/** Record on the server what the person posted of a review. */
	async function markPosted(
		project: Project,
		number: number,
		posted: { findingIds?: string[]; reviewId?: number } = {},
	): Promise<boolean> {
		if (!isRequestNumber(number)) return false;
		const result = await authedFetch(
			`${route}/${number}/posted?${query(project)}`,
			"POST",
			{
				finding_ids: posted.findingIds ?? [],
				...(isRequestNumber(posted.reviewId) ? { review_id: posted.reviewId } : {}),
			},
		);
		return result.ok;
	}

	/**
	 * Review a request on the server and tell the view, as a local review
	 * does: progress while it runs, then the saved review or the error.
	 */
	function start(
		project: Project,
		number: number,
		followup: boolean,
		settings: { model: string; thinkingLevel: string },
		tell: ReviewListener<R>,
	): void {
		if (!isRequestNumber(number)) {
			tell.error("Not a request number");
			return;
		}
		const key = `${project.id}:${number}`;
		if (running.has(key)) return;
		tell.progress("fetching", 5, "Starting the review on the server...");
		const thinking = THINKING.has(settings.thinkingLevel)
			? { thinking_level: settings.thinkingLevel }
			: {};
		const job = relayServerJob(project, `forge/${forge}/reviews`, {
			options: { number, followup, model: settings.model, ...thinking },
		});
		running.set(key, job);
		const errors: string[] = [];
		job.stdout.on("data", (data: Buffer) => {
			for (const line of data.toString("utf-8").split("\n")) {
				const match = PROGRESS.exec(line);
				if (match) {
					tell.progress("analyzing", Number.parseInt(match[1], 10), match[2].trim());
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
				tell.error(errors.filter(Boolean).join("\n") || "The review failed on the server");
				return;
			}
			void reviews(project, [number]).then(
				(saved) => {
					const review = saved[number];
					if (!review) {
						tell.error("Review completed but result not found");
						return;
					}
					tell.progress("complete", 100, "Review complete!");
					tell.complete(review);
				},
				(error: unknown) =>
					tell.error(error instanceof Error ? error.message : String(error)),
			);
		});
	}

	/** Stop a review running on the server; false when none runs from here. */
	function cancel(projectId: string, number: number): boolean {
		const key = `${projectId}:${number}`;
		const job = running.get(key);
		if (!job) return false;
		running.delete(key);
		return job.kill();
	}

	/** Whether a review of this request runs from here. */
	function isRunning(projectId: string, number: number): boolean {
		return running.has(`${projectId}:${number}`);
	}

	return { reviews, markPosted, start, cancel, isRunning };
}
