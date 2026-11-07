/**
 * The result of a PR's AI review, as the GitHub runner saves it
 * (`.workpilot/github/pr/review_<n>.json`): read from the project's folder
 * for a local project, from the server for a server project
 * (`server-pr-review.ts`).
 */

import { sanitizeNetworkData } from "./pr-logs";

/**
 * PR review finding from AI analysis
 */
export interface PRReviewFinding {
	id: string;
	severity: "critical" | "high" | "medium" | "low";
	category:
		| "security"
		| "quality"
		| "style"
		| "test"
		| "docs"
		| "pattern"
		| "performance";
	title: string;
	description: string;
	file: string;
	line: number;
	endLine?: number;
	suggestedFix?: string;
	fixable: boolean;
}

/**
 * Complete PR review result
 */
export interface PRReviewResult {
	jev?: import("../../../shared/types/jev").JevObservation;
	prNumber: number;
	repo: string;
	success: boolean;
	findings: PRReviewFinding[];
	summary: string;
	overallStatus: "approve" | "request_changes" | "comment";
	reviewId?: number;
	reviewedAt: string;
	error?: string;
	// Follow-up review fields
	reviewedCommitSha?: string;
	reviewedFileBlobs?: Record<string, string>; // filename → blob SHA for rebase-resistant follow-ups
	isFollowupReview?: boolean;
	previousReviewId?: number;
	resolvedFindings?: string[];
	unresolvedFindings?: string[];
	newFindingsSinceLastReview?: string[];
	// Track if findings have been posted to GitHub (enables follow-up review)
	hasPostedFindings?: boolean;
	postedFindingIds?: string[];
	postedAt?: string;
}

/** A saved review, from the runner's JSON; throws when it is not JSON. */
export function reviewFromJson(rawData: string): PRReviewResult {
	const sanitizedData = sanitizeNetworkData(rawData);
	const data = JSON.parse(sanitizedData);
	return {
		prNumber: data.pr_number,
		repo: data.repo,
		success: data.success,
		findings:
			data.findings?.map((f: Record<string, unknown>) => ({
				id: f.id,
				severity: f.severity,
				category: f.category,
				title: f.title,
				description: f.description,
				file: f.file,
				line: f.line,
				endLine: f.end_line,
				suggestedFix: f.suggested_fix,
				fixable: f.fixable ?? false,
			})) ?? [],
		summary: data.summary ?? "",
		overallStatus: data.overall_status ?? "comment",
		reviewId: data.review_id,
		reviewedAt: data.reviewed_at ?? new Date().toISOString(),
		error: data.error,
		// Follow-up review fields (snake_case -> camelCase)
		reviewedCommitSha: data.reviewed_commit_sha,
		jev: data.jev,
		reviewedFileBlobs: data.reviewed_file_blobs,
		isFollowupReview: data.is_followup_review ?? false,
		previousReviewId: data.previous_review_id,
		resolvedFindings: data.resolved_findings ?? [],
		unresolvedFindings: data.unresolved_findings ?? [],
		newFindingsSinceLastReview: data.new_findings_since_last_review ?? [],
		// Track posted findings for follow-up review eligibility
		hasPostedFindings: data.has_posted_findings ?? false,
		postedFindingIds: data.posted_finding_ids ?? [],
		postedAt: data.posted_at,
	};
}
