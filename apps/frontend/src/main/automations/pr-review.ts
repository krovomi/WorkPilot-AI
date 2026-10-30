/**
 * The automations' way into the GitHub PR review (plan of 29 October, IA7).
 * A `pr_opened` rule starts the same review as the button in GitHub PRs and
 * keeps it a draft: nothing is posted, nobody is assigned. The review
 * handlers are loaded on first use, since they bring the runner machinery.
 */

import type { BrowserWindow } from "electron";
import type { Project } from "../../shared/types";

export interface PRReviews {
	/** Whether the PR already has a review, saved or running. */
	has(project: Project, prNumber: number): Promise<boolean>;
	/** Starts a review whose result stays unposted; resolves once launched. */
	start(project: Project, prNumber: number): Promise<void>;
}

export function livePRReviews(getMainWindow: () => BrowserWindow | null): PRReviews {
	const handlers = () => import("../ipc-handlers/github/pr-handlers");
	return {
		async has(project, prNumber) {
			return (await handlers()).hasPRReview(project, prNumber);
		},
		async start(project, prNumber) {
			const window = getMainWindow();
			// The review reports to the window; without one it would run unseen.
			if (!window) throw new Error("The app window is not open");
			await (await handlers()).startDraftPRReview(project, prNumber, window);
		},
	};
}
