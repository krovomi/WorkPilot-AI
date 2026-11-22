/**
 * The project's acceptance rate of PR review findings, and the learned rules
 * that change its reviews (#361, lot 2). Read here from the dataset, bounded
 * (`review-feedback-dataset.ts`), with the backend's rules: a kind of remark
 * rejected `threshold` times more than accepted is downgraded to low, twice
 * that and it is dropped; security is never touched.
 *
 * The threshold is the one the reviewer runs with:
 * `WORKPILOT_REVIEW_FEEDBACK_THRESHOLD` from the environment the runner
 * inherits, else from the backend's `.env`, else 3. The figures by month
 * (lot 4) are `review-feedback-metrics.ts`'s.
 */

import type {
	ReviewFeedbackCategoryStats,
	ReviewFeedbackRuleStats,
	ReviewFeedbackStats,
} from "../../../shared/types/review-feedback";
import { loadBackendEnv } from "../../source-env";
import {
	displayLabel,
	type FeedbackRecord,
	net,
	PROTECTED_CATEGORIES,
	rejections,
	resolveThreshold,
	tallyBySignature,
	topReason,
} from "./review-feedback-dataset";
import { monthlyMetrics, type ReviewCount } from "./review-feedback-metrics";
import { getBackendPath } from "./utils/subprocess-runner";

export const THRESHOLD_ENV = "WORKPILOT_REVIEW_FEEDBACK_THRESHOLD";

function backendValue(): string | undefined {
	const backendPath = getBackendPath();
	if (!backendPath) return undefined;
	try {
		return loadBackendEnv(backendPath)[THRESHOLD_ENV];
	} catch {
		return undefined;
	}
}

/** The runner gets the app's environment first; its `.env` fills what is unset. */
export function configuredThreshold(
	env: NodeJS.ProcessEnv = process.env,
	fromBackend: () => string | undefined = backendValue,
): number {
	return resolveThreshold(env[THRESHOLD_ENV] ?? fromBackend());
}

function byCategory(
	records: readonly FeedbackRecord[],
): ReviewFeedbackCategoryStats[] {
	const categories = new Map<string, ReviewFeedbackCategoryStats>();
	for (const record of records) {
		let stats = categories.get(record.category);
		if (!stats) {
			stats = {
				category: record.category,
				accepted: 0,
				rejected: 0,
				notApplicable: 0,
			};
			categories.set(record.category, stats);
		}
		if (record.verdict === "accepted") stats.accepted += 1;
		else if (record.verdict === "rejected") stats.rejected += 1;
		else stats.notApplicable += 1;
	}
	const total = (s: ReviewFeedbackCategoryStats) =>
		s.accepted + s.rejected + s.notApplicable;
	return [...categories.values()].sort(
		(a, b) => total(b) - total(a) || a.category.localeCompare(b.category, "en"),
	);
}

/** The signatures that change the reviews, the most rejected first. */
export function learnedRules(
	records: readonly FeedbackRecord[],
	threshold: number,
): ReviewFeedbackRuleStats[] {
	const rules: ReviewFeedbackRuleStats[] = [];
	for (const tally of tallyBySignature(records).values()) {
		if (PROTECTED_CATEGORIES.has(tally.category)) continue;
		const score = net(tally);
		if (score < threshold) continue;
		rules.push({
			signature: tally.signature,
			category: tally.category,
			label: displayLabel(tally.title),
			rejections: rejections(tally),
			accepts: tally.accepted,
			status: score >= 2 * threshold ? "dropped" : "downgraded",
			topReason: topReason(tally),
		});
	}
	const netOf = (rule: ReviewFeedbackRuleStats) => rule.rejections - rule.accepts;
	return rules.sort(
		(a, b) => netOf(b) - netOf(a) || a.signature.localeCompare(b.signature, "en"),
	);
}

export function computeStats(
	records: readonly FeedbackRecord[],
	threshold: number,
	reviews: readonly ReviewCount[] = [],
): ReviewFeedbackStats {
	return {
		threshold,
		categories: byCategory(records),
		rules: learnedRules(records, threshold),
		months: monthlyMetrics(records, reviews, threshold),
	};
}
