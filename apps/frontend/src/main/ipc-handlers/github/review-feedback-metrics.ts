/**
 * The panel's figures by month (#361, lot 4): how many findings the reviewer
 * raised per pull request, and how many kinds of remark it learned to stop
 * raising. Both are computed on the machine (a local project) or from what
 * the team's server answers (a server project); nothing is sent elsewhere.
 *
 * - **Findings per PR**: each saved review (`.workpilot/github/pr/review_<n>.json`,
 *   the latest review of a PR) counts its findings in the month it ran. The
 *   newest `MAX_COUNTED_REVIEWS` reviews are read, each bounded, each a regular
 *   file inside the project.
 * - **Rules learned**: a kind of remark the reviewer now downgrades or drops
 *   counts in the month of the verdict that brought it to the threshold
 *   (the dataset is append-only, so its order is the verdicts' order).
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReviewFeedbackMonth } from "../../../shared/types/review-feedback";
import { resolveUnder } from "../../security/renderer-path";
import {
	type FeedbackRecord,
	monthOf,
	PROTECTED_CATEGORIES,
} from "./review-feedback-dataset";

export interface ReviewCount {
	pr: number;
	month: string;
	findings: number;
}

/** As the server bounds them (`forge_review_feedback.review_counts`). */
export const MAX_COUNTED_REVIEWS = 200;
const MAX_REVIEW_BYTES = 2_000_000;
/** Months shown, the newest first. */
export const MONTHS_SHOWN = 6;
const REVIEW_FILE = /^review_([1-9][0-9]{0,8})\.json$/;
const REVIEWS_RELATIVE_PATH = path.join(".workpilot", "github", "pr");

/** A saved review, or the server's line for one, as a count; else `null`. */
export function reviewCount(
	pr: unknown,
	at: unknown,
	findings: unknown,
): ReviewCount | null {
	const month = monthOf(at);
	if (
		typeof pr !== "number" ||
		!Number.isInteger(pr) ||
		pr <= 0 ||
		pr >= 1_000_000_000 ||
		!month
	) {
		return null;
	}
	const count = Array.isArray(findings)
		? findings.length
		: typeof findings === "number" && Number.isInteger(findings) && findings >= 0
			? findings
			: null;
	return count === null ? null : { pr, month, findings: count };
}

function readReview(directory: string, name: string): unknown {
	const file = path.join(directory, name);
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_REVIEW_BYTES) return null;
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

/** The counts of a local project's saved reviews, the newest PRs first. */
export function readReviewCounts(
	projectPath: string,
	list: (directory: string) => string[] = readdirSync,
): ReviewCount[] {
	const directory = resolveUnder(projectPath, REVIEWS_RELATIVE_PATH, "directory");
	if (!directory) return [];
	let names: string[];
	try {
		names = list(directory);
	} catch {
		return [];
	}
	const numbers = names
		.map((name) => REVIEW_FILE.exec(name)?.[1])
		.filter((n): n is string => n !== undefined)
		.map(Number)
		.sort((a, b) => b - a)
		.slice(0, MAX_COUNTED_REVIEWS);
	const counts: ReviewCount[] = [];
	for (const pr of numbers) {
		const data = readReview(directory, `review_${pr}.json`);
		const review =
			typeof data === "object" && data !== null && !Array.isArray(data)
				? (data as Record<string, unknown>)
				: {};
		const count = reviewCount(pr, review.reviewed_at, review.findings);
		if (count) counts.push(count);
	}
	return counts;
}

/** The server's `reviews`, kept to what has the shape of a count. */
export function serverReviewCounts(value: unknown): ReviewCount[] {
	if (!Array.isArray(value)) return [];
	const counts: ReviewCount[] = [];
	for (const item of value.slice(0, MAX_COUNTED_REVIEWS)) {
		if (typeof item !== "object" || item === null) continue;
		const { pr, at, findings } = item as Record<string, unknown>;
		const count = reviewCount(pr, at, findings);
		if (count) counts.push(count);
	}
	return counts;
}

/** Month → the kinds of remark that reached the threshold then, and stay there. */
export function rulesLearnedByMonth(
	records: readonly FeedbackRecord[],
	threshold: number,
): Map<string, number> {
	const running = new Map<string, { net: number; month: string | null }>();
	for (const record of records) {
		if (PROTECTED_CATEGORIES.has(record.category)) continue;
		const state = running.get(record.signature) ?? { net: 0, month: null };
		const before = state.net;
		state.net += record.verdict === "accepted" ? -1 : 1;
		if (before < threshold && state.net >= threshold) state.month = record.month;
		running.set(record.signature, state);
	}
	const months = new Map<string, number>();
	for (const { net, month } of running.values()) {
		if (net >= threshold && month) months.set(month, (months.get(month) ?? 0) + 1);
	}
	return months;
}

/** The newest `MONTHS_SHOWN` months that have a review or a learned rule. */
export function monthlyMetrics(
	records: readonly FeedbackRecord[],
	reviews: readonly ReviewCount[],
	threshold: number,
): ReviewFeedbackMonth[] {
	const months = new Map<string, ReviewFeedbackMonth>();
	const at = (month: string) => {
		let row = months.get(month);
		if (!row) {
			row = { month, reviews: 0, findings: 0, rulesLearned: 0 };
			months.set(month, row);
		}
		return row;
	};
	for (const review of reviews) {
		const row = at(review.month);
		row.reviews += 1;
		row.findings += review.findings;
	}
	for (const [month, count] of rulesLearnedByMonth(records, threshold)) {
		at(month).rulesLearned = count;
	}
	return [...months.values()]
		.sort((a, b) => b.month.localeCompare(a.month, "en"))
		.slice(0, MONTHS_SHOWN);
}
