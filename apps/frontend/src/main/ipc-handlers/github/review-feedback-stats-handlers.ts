/**
 * The project's acceptance rate of PR review findings, the reset of a learned
 * rule and the conventions file (#361, lot 2).
 *
 * The renderer names a project by id and, for a reset, a signature; nothing
 * else. Each is checked here before a folder is opened: the signature must
 * have the shape of one and be a kind of remark the dataset holds
 * (`recordReset`). A server project's reviews live on the server, which does
 * not take feedback yet: every call answers `server_project`.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	ReviewConventionsResult,
	ReviewFeedbackStatsResult,
} from "../../../shared/types/review-feedback";
import { serverProjectOf } from "../server-review-jobs";
import { writeConventions } from "./review-conventions";
import { SIGNATURE } from "./review-feedback-dataset";
import { computeStats, configuredThreshold } from "./review-feedback-stats";
import { readRecords, recordReset } from "./review-feedback-store";
import { withProjectOrNull } from "./utils/project-middleware";

type Refusal = { success: false; error: "invalid" | "server_project" };

function refusal(projectId: unknown): Refusal | null {
	if (typeof projectId !== "string") return { success: false, error: "invalid" };
	if (serverProjectOf(projectId)) {
		return { success: false, error: "server_project" };
	}
	return null;
}

function statsOf(projectPath: string): ReviewFeedbackStatsResult {
	return {
		success: true,
		stats: computeStats(readRecords(projectPath), configuredThreshold()),
	};
}

export function registerReviewFeedbackStatsHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_STATS,
		async (_event, projectId: unknown): Promise<ReviewFeedbackStatsResult> => {
			const refused = refusal(projectId);
			if (refused) return refused;
			const result = await withProjectOrNull(projectId as string, async (project) =>
				statsOf(project.path),
			);
			return result ?? { success: false, error: "not_found" };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_RESET,
		async (
			_event,
			projectId: unknown,
			signature: unknown,
		): Promise<ReviewFeedbackStatsResult> => {
			const refused = refusal(projectId);
			if (refused) return refused;
			if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
				return { success: false, error: "invalid" };
			}
			const result = await withProjectOrNull(
				projectId as string,
				async (project): Promise<ReviewFeedbackStatsResult> => {
					const outcome = recordReset(project.path, signature);
					if (outcome !== "reset") return { success: false, error: outcome };
					return statsOf(project.path);
				},
			);
			return result ?? { success: false, error: "not_found" };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_REVIEW_CONVENTIONS_WRITE,
		async (_event, projectId: unknown): Promise<ReviewConventionsResult> => {
			const refused = refusal(projectId);
			if (refused) return refused;
			const result = await withProjectOrNull(projectId as string, async (project) =>
				writeConventions(project.path, configuredThreshold()),
			);
			return result ?? { success: false, error: "not_found" };
		},
	);
}
