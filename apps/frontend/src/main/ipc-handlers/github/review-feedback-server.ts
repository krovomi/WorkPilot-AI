/**
 * Feedback on a server project's PR review findings (#361, lot 3).
 *
 * A server project's reviews run in its clone on the server, so its feedback
 * is kept there too (`apps/backend/shared_features/forge_review_feedback.py`):
 * the review job learns from the clone's dataset. This module is the app's
 * side of those routes. It sends a project id, a PR number, a finding id, a
 * verdict, a reason and a note, already checked by the handler; the server
 * reads the finding from the review it saved. What comes back is checked
 * here before it reaches the view.
 *
 * The acceptance rate and the learned rules are computed from the dataset
 * with the same code as a local project (`computeStats`), on the threshold
 * the server's review jobs run with. On a server, a member's rejection waits
 * for a maintainer (the project's owner) before the reviewer learns from it:
 * the view lists those held rejections, and a maintainer approves or discards
 * each one. Only a maintainer may reset a rule; the server checks it. The
 * conventions file is built from the server's dataset and saved where the
 * person chooses (lot 4).
 */

import type { Project } from "../../../shared/types";
import {
	REVIEW_FEEDBACK_VERDICTS,
	type HeldRejection,
	type ReviewConventionsResult,
	type ReviewFeedbackMap,
	type ReviewFeedbackResult,
	type ReviewFeedbackStatsResult,
	type ReviewFeedbackVerdict,
} from "../../../shared/types/review-feedback";
import { authedFetch } from "../../server-connection";
import { saveConventionsAs } from "./review-conventions";
import {
	displayLabel,
	type FeedbackRecord,
	FINDING_ID,
	parseDataset,
	resolveThreshold,
	validRecord,
} from "./review-feedback-dataset";
import { serverReviewCounts } from "./review-feedback-metrics";
import { computeStats } from "./review-feedback-stats";
import type { ValidFeedback } from "./review-feedback-store";

const ROUTE = "/api/features/forge/github/reviews";
/** As the server bounds them. */
const MAX_HELD = 500;
const NOTE_MAX = 280;

function query(project: Project): string {
	return `project_id=${encodeURIComponent(project.id)}`;
}

function isVerdict(value: unknown): value is ReviewFeedbackVerdict {
	return (
		typeof value === "string" &&
		(REVIEW_FEEDBACK_VERDICTS as readonly string[]).includes(value)
	);
}

function asObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The server's answer for one PR, kept to what has the shape of one. */
function prFeedback(data: unknown): ReviewFeedbackResult {
	const body = asObject(data);
	const feedback: ReviewFeedbackMap = {};
	for (const [id, verdict] of Object.entries(asObject(body?.feedback) ?? {})) {
		if (FINDING_ID.test(id) && isVerdict(verdict)) feedback[id] = verdict;
	}
	const held = Array.isArray(body?.held)
		? body.held.filter(
				(id): id is string =>
					typeof id === "string" && FINDING_ID.test(id) && id in feedback,
			)
		: [];
	return { success: true, feedback, held };
}

/** The latest verdict per finding of a server project's PR, and the held ones. */
export async function serverFeedback(
	project: Project,
	prNumber: number,
): Promise<ReviewFeedbackResult> {
	const result = await authedFetch<unknown>(
		`${ROUTE}/${prNumber}/feedback?${query(project)}`,
		"GET",
	);
	return result.ok ? prFeedback(result.data) : { success: false, error: "not_found" };
}

/** Record a checked verdict on the server, as the person. */
export async function recordServerFeedback(
	project: Project,
	feedback: ValidFeedback,
): Promise<ReviewFeedbackResult> {
	const result = await authedFetch<unknown>(
		`${ROUTE}/${feedback.prNumber}/feedback?${query(project)}`,
		"POST",
		{
			finding_id: feedback.findingId,
			verdict: feedback.verdict,
			reason: feedback.reason,
			note: feedback.note,
		},
	);
	return result.ok
		? prFeedback(result.data)
		: { success: false, error: "write_failed" };
}

/** A note as one line: control characters out, whitespace collapsed, bounded. */
function oneLine(text: string): string {
	let printable = "";
	for (const char of text) {
		printable += char < " " || char === "\u007f" ? " " : char;
	}
	return Array.from(printable.replace(/\s+/g, " ").trim())
		.slice(0, NOTE_MAX)
		.join("");
}

function heldRejection(value: unknown): HeldRejection | null {
	const record = validRecord(value);
	if (!record || record.verdict === "accepted") return null;
	const note = asObject(value)?.note;
	return {
		prNumber: record.pr,
		findingId: record.findingId,
		verdict: record.verdict,
		reason: record.reason,
		note: typeof note === "string" ? oneLine(note) : "",
		category: record.category,
		label: displayLabel(record.title),
	};
}

interface ServerDataset {
	records: FeedbackRecord[];
	threshold: number;
	body: Record<string, unknown> | null;
}

/** The server's dataset as the reviewer reads it, and its threshold. */
async function serverDataset(project: Project): Promise<ServerDataset | null> {
	const result = await authedFetch<unknown>(
		`${ROUTE}/feedback?${query(project)}`,
		"GET",
	);
	if (!result.ok) return null;
	const body = asObject(result.data);
	const dataset = typeof body?.dataset === "string" ? body.dataset : "";
	const threshold =
		typeof body?.threshold === "number" && Number.isInteger(body.threshold)
			? String(body.threshold)
			: undefined;
	return {
		records: parseDataset(dataset),
		threshold: resolveThreshold(threshold),
		body,
	};
}

/** The project-wide view of a server project, computed as a local one's. */
export async function serverFeedbackStats(
	project: Project,
): Promise<ReviewFeedbackStatsResult> {
	const fetched = await serverDataset(project);
	if (!fetched) return { success: false, error: "not_found" };
	const { records, threshold, body } = fetched;
	const held = (Array.isArray(body?.held) ? body.held : [])
		.slice(-MAX_HELD)
		.map(heldRejection)
		.filter((item): item is HeldRejection => item !== null);
	return {
		success: true,
		stats: {
			...computeStats(records, threshold, serverReviewCounts(body?.reviews)),
			server: { maintainer: body?.maintainer === true, held },
		},
	};
}

/** The conventions file of a server project, from its dataset, saved here. */
export async function saveServerConventions(
	project: Project,
): Promise<ReviewConventionsResult> {
	const fetched = await serverDataset(project);
	if (!fetched) return { success: false, error: "not_found" };
	return saveConventionsAs(fetched.records, fetched.threshold);
}

/** Forget a learned rule on the server (a maintainer's), then the new view. */
export async function resetServerRule(
	project: Project,
	signature: string,
): Promise<ReviewFeedbackStatsResult> {
	const result = await authedFetch<unknown>(
		`${ROUTE}/feedback/reset?${query(project)}`,
		"POST",
		{ signature },
	);
	if (!result.ok) return { success: false, error: "write_failed" };
	return serverFeedbackStats(project);
}

/** A maintainer approves or discards a held rejection, then the new view. */
export async function decideServerHeld(
	project: Project,
	prNumber: number,
	findingId: string,
	approve: boolean,
): Promise<ReviewFeedbackStatsResult> {
	const result = await authedFetch<unknown>(
		`${ROUTE}/feedback/held?${query(project)}`,
		"POST",
		{ pr: prNumber, finding_id: findingId, approve },
	);
	if (!result.ok) return { success: false, error: "write_failed" };
	return serverFeedbackStats(project);
}
