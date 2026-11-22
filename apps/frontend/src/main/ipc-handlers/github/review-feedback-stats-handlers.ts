/**
 * The project's acceptance rate of PR review findings, the reset of a learned
 * rule and the conventions file (#361, lot 2).
 *
 * The renderer names a project by id and, for a reset, a signature; nothing
 * else. Each is checked here before a folder is opened: the signature must
 * have the shape of one and be a kind of remark the dataset holds
 * (`recordReset`). A server project's feedback lives on the server
 * (`review-feedback-server.ts`), which also holds a member's rejections until
 * a maintainer decides; its conventions file is built from the server's
 * dataset and saved where the person chooses in a native dialog (the server's
 * clone is nobody's working copy).
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	ReviewConventionsResult,
	ReviewFeedbackStatsResult,
} from "../../../shared/types/review-feedback";
import { serverProjectOf } from "../server-review-jobs";
import { writeConventions } from "./review-conventions";
import { FINDING_ID, SIGNATURE } from "./review-feedback-dataset";
import {
	decideServerHeld,
	resetServerRule,
	saveServerConventions,
	serverFeedbackStats,
} from "./review-feedback-server";
import { computeStats, configuredThreshold } from "./review-feedback-stats";
import { isPrNumber, readRecords, recordReset } from "./review-feedback-store";
import { withProjectOrNull } from "./utils/project-middleware";

type Refusal = { success: false; error: "invalid" };

/** Called once a server project was answered: what is left is a local one. */
function refusal(projectId: unknown): Refusal | null {
	if (typeof projectId !== "string") return { success: false, error: "invalid" };
	return null;
}

const INVALID = { success: false, error: "invalid" } as const;

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
			const remote = serverProjectOf(projectId);
			if (remote) return serverFeedbackStats(remote);
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
			if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
				return INVALID;
			}
			const remote = serverProjectOf(projectId);
			if (remote) return resetServerRule(remote, signature);
			const refused = refusal(projectId);
			if (refused) return refused;
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
		IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_HELD_DECIDE,
		async (
			_event,
			projectId: unknown,
			prNumber: unknown,
			findingId: unknown,
			approve: unknown,
		): Promise<ReviewFeedbackStatsResult> => {
			if (
				typeof projectId !== "string" ||
				!isPrNumber(prNumber) ||
				typeof findingId !== "string" ||
				!FINDING_ID.test(findingId) ||
				typeof approve !== "boolean"
			) {
				return INVALID;
			}
			// Only a server holds rejections: a local project's count at once.
			const remote = serverProjectOf(projectId);
			if (!remote) return { success: false, error: "not_found" };
			return decideServerHeld(remote, prNumber, findingId, approve);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.GITHUB_PR_REVIEW_CONVENTIONS_WRITE,
		async (_event, projectId: unknown): Promise<ReviewConventionsResult> => {
			const remote = serverProjectOf(projectId);
			if (remote) return saveServerConventions(remote);
			const refused = refusal(projectId);
			if (refused) return refused;
			const result = await withProjectOrNull(projectId as string, async (project) =>
				writeConventions(project.path, configuredThreshold()),
			);
			return result ?? { success: false, error: "not_found" };
		},
	);
}
