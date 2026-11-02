/**
 * The automations' way into the GitHub PR review (plan of 29 October, IA7).
 * A `pr_opened` rule starts the same review as the button in GitHub PRs and
 * keeps it a draft: nothing is posted, nobody is assigned.
 */

import type { BrowserWindow } from "electron";
import type { Project } from "../../shared/types";
import { hasPRReview, startDraftPRReview } from "../ipc-handlers/github/pr-handlers";

export interface PRReviews {
	/** Whether the PR already has a review, saved or running. */
	has(project: Project, prNumber: number): Promise<boolean>;
	/** Starts a review whose result stays unposted; resolves once launched. */
	start(project: Project, prNumber: number): Promise<void>;
}

export function livePRReviews(getMainWindow: () => BrowserWindow | null): PRReviews {
	return {
		async has(project, prNumber) {
			return hasPRReview(project, prNumber);
		},
		async start(project, prNumber) {
			const window = getMainWindow();
			// The review reports to the window; without one it would run unseen.
			if (!window) throw new Error("The app window is not open");
			await startDraftPRReview(project, prNumber, window);
		},
	};
}
