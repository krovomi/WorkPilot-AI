/**
 * Accept / reject / not applicable on a PR review finding (#361).
 *
 * The renderer names a project by id, a PR by number and a finding by id;
 * every argument is checked here (`validateFeedback`) before anything is read
 * or written, and the project's folder is the one the project store holds.
 * A server project's reviews live on the server, which keeps their feedback
 * (`review-feedback-server.ts`): the checked call is sent there.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { ReviewFeedbackResult } from "../../../shared/types/review-feedback";
import { serverProjectOf } from "../server-review-jobs";
import { recordServerFeedback, serverFeedback } from "./review-feedback-server";
import {
	isPrNumber,
	readFeedback,
	recordFeedback,
	validateFeedback,
} from "./review-feedback-store";
import { withProjectOrNull } from "./utils/project-middleware";

export function registerReviewFeedbackHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_SET,
		async (
			_event,
			projectId: unknown,
			prNumber: unknown,
			input: unknown,
		): Promise<ReviewFeedbackResult> => {
			if (typeof projectId !== "string") {
				return { success: false, error: "invalid" };
			}
			const feedback = validateFeedback(prNumber, input);
			if (!feedback) return { success: false, error: "invalid" };
			const remote = serverProjectOf(projectId);
			if (remote) return recordServerFeedback(remote, feedback);
			const result = await withProjectOrNull(projectId, async (project) =>
				recordFeedback(project.path, feedback),
			);
			return result ?? { success: false, error: "not_found" };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_GET,
		async (
			_event,
			projectId: unknown,
			prNumber: unknown,
		): Promise<ReviewFeedbackResult> => {
			if (typeof projectId !== "string" || !isPrNumber(prNumber)) {
				return { success: false, error: "invalid" };
			}
			const remote = serverProjectOf(projectId);
			if (remote) return serverFeedback(remote, prNumber);
			const result = await withProjectOrNull(projectId, async (project) => ({
				success: true as const,
				feedback: readFeedback(project.path, prNumber),
			}));
			return result ?? { success: false, error: "not_found" };
		},
	);
}
