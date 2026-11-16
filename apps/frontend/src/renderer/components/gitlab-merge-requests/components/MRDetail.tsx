import { JevStatus } from "../../jev/JevStatus";
import {
	AlertCircle,
	AlertTriangle,
	CheckCheck,
	CheckCircle,
	Clock,
	ExternalLink,
	FileDiff,
	GitBranch,
	GitMerge,
	Loader2,
	MessageSquare,
	RefreshCw,
	Send,
	Sparkles,
	User,
	Users,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitLabNewCommitsCheck } from "../../../../shared/types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { ErrorBoundary } from "../../ui/error-boundary";
import { Progress } from "../../ui/progress";
import { ScrollArea } from "../../ui/scroll-area";
import type {
	GitLabMergeRequest,
	GitLabMRReviewProgress,
	GitLabMRReviewResult,
} from "../hooks/useGitLabMRs";
import {
	getMRDetailStatus,
	isReadyToMerge,
	type MRDetailStatus,
} from "../utils/mr-detail-status";
import { ReviewFindings } from "./ReviewFindings";
import { formatAppDate } from "@/lib/date-format";

interface MRDetailProps {
	projectId?: string;
	mr: GitLabMergeRequest;
	reviewResult: GitLabMRReviewResult | null;
	reviewProgress: GitLabMRReviewProgress | null;
	isReviewing: boolean;
	onRunReview: () => void;
	onRunFollowupReview: () => void;
	onCheckNewCommits: () => Promise<GitLabNewCommitsCheck>;
	onCancelReview: () => void;
	onPostReview: (selectedFindingIds?: string[]) => Promise<boolean>;
	onMergeMR: (mergeMethod?: "merge" | "squash" | "rebase") => Promise<boolean>;
	onApproveMR: () => Promise<boolean>;
}

function formatDate(dateString: string): string {
	return formatAppDate(dateString, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** The badge of the review's verdict. */
const VERDICT_LOOK: Record<
	GitLabMRReviewResult["overallStatus"],
	{ className: string; label: string }
> = {
	approve: {
		className: "bg-success/20 text-success border-success/50",
		label: "gitlab:mrReview.overallStatus.approve",
	},
	request_changes: {
		className: "bg-destructive/20 text-destructive border-destructive/50",
		label: "gitlab:mrReview.overallStatus.requestChanges",
	},
	comment: { className: "bg-muted", label: "gitlab:mrReview.overallStatus.comment" },
};

const MR_STATE_COLOR: Record<GitLabMergeRequest["state"], string> = {
	opened: "bg-success/20 text-success border-success/50",
	merged: "bg-purple-500/20 text-purple-500 border-purple-500/50",
	closed: "bg-destructive/20 text-destructive border-destructive/50",
	locked: "bg-muted",
};

/** The banner's look for each status. */
const STATUS_LOOK: Record<
	MRDetailStatus,
	{ Icon: typeof Sparkles; color: string }
> = {
	not_reviewed: {
		Icon: Sparkles,
		color: "bg-muted text-muted-foreground border-muted",
	},
	ready_for_followup: { Icon: RefreshCw, color: "bg-info/20 text-info border-info/50" },
	ready_to_merge: {
		Icon: CheckCheck,
		color: "bg-success/20 text-success border-success/50",
	},
	followup_issues_remain: {
		Icon: AlertTriangle,
		color: "bg-warning/20 text-warning border-warning/50",
	},
	waiting_for_changes: {
		Icon: AlertTriangle,
		color: "bg-warning/20 text-warning border-warning/50",
	},
	needs_attention: {
		Icon: AlertCircle,
		color: "bg-destructive/20 text-destructive border-destructive/50",
	},
	reviewed_pending_post: {
		Icon: MessageSquare,
		color: "bg-primary/20 text-primary border-primary/50",
	},
};

/** What a follow-up review did with the previous findings. */
const FOLLOWUP_BADGES = [
	{
		field: "resolvedFindings",
		label: "gitlab:mrReview.resolvedCount",
		Icon: CheckCircle,
		className: "bg-success/20 text-success border-success/50",
	},
	{
		field: "unresolvedFindings",
		label: "gitlab:mrReview.stillOpenCount",
		Icon: AlertCircle,
		className: "bg-warning/20 text-warning border-warning/50",
	},
	{
		field: "newFindingsSinceLastReview",
		label: "gitlab:mrReview.newIssueCount",
		Icon: XCircle,
		className: "bg-destructive/20 text-destructive border-destructive/50",
	},
] as const;

/**
 * One page per MR: opening another MR starts a fresh page, so findings
 * posted or selected on one MR, and its new-commit check, never show on the
 * next.
 */
export function MRDetail(props: MRDetailProps) {
	return <MRDetailPage key={props.mr.iid} {...props} />;
}

function MRDetailPage({
	projectId,
	mr,
	reviewResult,
	reviewProgress,
	isReviewing,
	onRunReview,
	onRunFollowupReview,
	onCheckNewCommits,
	onCancelReview,
	onPostReview,
	onMergeMR,
	onApproveMR,
}: MRDetailProps) {
	const { t } = useTranslation("common");
	// Selection state for findings
	const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(
		new Set(),
	);
	const [postedFindingIds, setPostedFindingIds] = useState<Set<string>>(
		new Set(),
	);
	const [isPostingFindings, setIsPostingFindings] = useState(false);
	const [postSuccess, setPostSuccess] = useState<{
		count: number;
		timestamp: number;
	} | null>(null);
	const [isMerging, setIsMerging] = useState(false);
	const [isApproving, setIsApproving] = useState(false);
	const [newCommitsCheck, setNewCommitsCheck] =
		useState<GitLabNewCommitsCheck | null>(null);

	// Auto-select critical and high findings when review completes (excluding already posted)
	useEffect(() => {
		if (reviewResult?.success && reviewResult.findings.length > 0) {
			const importantFindings = reviewResult.findings
				.filter(
					(f) =>
						(f.severity === "critical" || f.severity === "high") &&
						!postedFindingIds.has(f.id),
				)
				.map((f) => f.id);
			setSelectedFindingIds(new Set(importantFindings));
		}
	}, [reviewResult, postedFindingIds]);

	// Check for new commits only when findings have been posted to GitLab
	// Follow-up review only makes sense after initial findings are shared with the contributor
	const hasPostedFindings =
		postedFindingIds.size > 0 || reviewResult?.hasPostedFindings;

	const checkForNewCommits = useCallback(async () => {
		// Only check for new commits if we have a review AND findings have been posted
		if (
			reviewResult?.success &&
			reviewResult.reviewedCommitSha &&
			hasPostedFindings
		) {
			// A check that fails says nothing new; it used to be an unhandled
			// rejection.
			setNewCommitsCheck(await onCheckNewCommits().catch(() => null));
		} else {
			setNewCommitsCheck(null);
		}
	}, [reviewResult, onCheckNewCommits, hasPostedFindings]);

	useEffect(() => {
		checkForNewCommits();
	}, [checkForNewCommits]);

	// Clear success message after 3 seconds
	useEffect(() => {
		if (postSuccess) {
			const timer = setTimeout(() => setPostSuccess(null), 3000);
			return () => clearTimeout(timer);
		}
	}, [postSuccess]);

	// Count selected findings by type for the button label
	const selectedCount = selectedFindingIds.size;

	const readyToMerge = isReadyToMerge(reviewResult);
	const mrStatus = getMRDetailStatus({
		result: reviewResult,
		postedIds: postedFindingIds,
		newCommitsCheck,
	});
	const { Icon: StatusIcon, color: statusColor } = STATUS_LOOK[mrStatus.status];

	const handlePostReview = async () => {
		const idsToPost = Array.from(selectedFindingIds);

		setIsPostingFindings(true);
		try {
			const success = await onPostReview(idsToPost);
			if (success) {
				// Mark these findings as posted
				setPostedFindingIds((prev) => new Set([...prev, ...idsToPost]));
				// Clear selection
				setSelectedFindingIds(new Set());
				// Show success message. The new-commit check follows on its own:
				// posting changes hasPostedFindings, which re-runs the effect. A
				// delayed call here kept the old closure and wiped its answer.
				setPostSuccess({ count: idsToPost.length, timestamp: Date.now() });
			}
		} finally {
			setIsPostingFindings(false);
		}
	};

	const handleApprove = async () => {
		setIsApproving(true);
		try {
			await onApproveMR();
		} finally {
			setIsApproving(false);
		}
	};

	const handleMerge = async () => {
		setIsMerging(true);
		try {
			await onMergeMR("squash"); // Default to squash merge
		} finally {
			setIsMerging(false);
		}
	};

	return (
		<ErrorBoundary>
			<ScrollArea className="flex-1">
				<div className="p-4 space-y-4">
					<JevStatus
						projectId={projectId}
						workflow="gitlab-review"
						observation={reviewResult?.jev}
					/>
					{/* Header */}
					<div className="space-y-2">
						<div className="flex items-start justify-between gap-4">
							<div className="flex items-center gap-2">
								<Badge variant="outline" className={MR_STATE_COLOR[mr.state]}>
									{t(`gitlab:mergeRequests.states.${mr.state}`)}
								</Badge>
								<span className="text-sm text-muted-foreground">!{mr.iid}</span>
							</div>
							<Button
								variant="ghost"
								size="icon"
								asChild
								aria-label={t("accessibility.openOnGitLabAriaLabel")}
							>
								<a href={mr.webUrl} target="_blank" rel="noopener noreferrer">
									<ExternalLink className="h-4 w-4" />
								</a>
							</Button>
						</div>
						<h2 className="text-lg font-semibold text-foreground">
							{mr.title}
						</h2>
					</div>

					{/* Meta */}
					<div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
						<div className="flex items-center gap-1">
							<User className="h-4 w-4" />
							{mr.author.username}
						</div>
						<div className="flex items-center gap-1">
							<Clock className="h-4 w-4" />
							{formatDate(mr.createdAt)}
						</div>
						<div className="flex items-center gap-1">
							<GitBranch className="h-4 w-4" />
							{mr.sourceBranch} → {mr.targetBranch}
						</div>
						{mr.assignees && mr.assignees.length > 0 && (
							<div className="flex items-center gap-1">
								<Users className="h-4 w-4" />
								{mr.assignees.map((a) => a.username).join(", ")}
							</div>
						)}
					</div>

					{/* Merge Status */}
					{mr.mergeStatus && (
						<div className="flex items-center gap-4">
							<Badge variant="outline" className="flex items-center gap-1">
								<FileDiff className="h-3 w-3" />
								{t(`gitlab:mrReview.mergeStatus.${mr.mergeStatus}`, {
									defaultValue: mr.mergeStatus,
								})}
							</Badge>
						</div>
					)}

					{/* Actions */}
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							{/* Show Follow-up Review button if there are new commits since last review */}
							{newCommitsCheck?.hasNewCommits && !isReviewing ? (
								<Button
									onClick={onRunFollowupReview}
									className="flex-1"
									variant="secondary"
								>
									<RefreshCw className="h-4 w-4 mr-2" />
									{t("gitlab:mrReview.followupWithCommits", {
										count: newCommitsCheck.newCommitCount ?? 0,
									})}
								</Button>
							) : (
								<Button
									onClick={onRunReview}
									disabled={isReviewing}
									className="flex-1"
								>
									{isReviewing ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("gitlab:mrReview.reviewing")}
										</>
									) : (
										<>
											<Sparkles className="h-4 w-4 mr-2" />
											{t("gitlab:mrReview.runReview")}
										</>
									)}
								</Button>
							)}
							{isReviewing && (
								<Button onClick={onCancelReview} variant="destructive">
									<XCircle className="h-4 w-4 mr-2" />
									{t("common:buttons.cancel")}
								</Button>
							)}
							{reviewResult?.success && selectedCount > 0 && !isReviewing && (
								<Button
									onClick={handlePostReview}
									variant="secondary"
									disabled={isPostingFindings}
								>
									{isPostingFindings ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("gitlab:mrReview.posting")}
										</>
									) : (
										<>
											<Send className="h-4 w-4 mr-2" />
											{t("gitlab:mrReview.postCount", { count: selectedCount })}
										</>
									)}
								</Button>
							)}
							{/* Success message */}
							{postSuccess && (
								<div className="flex items-center gap-2 text-success text-sm">
									<CheckCircle className="h-4 w-4" />
									{t("gitlab:mrReview.postedCount", { count: postSuccess.count })}
								</div>
							)}
						</div>

						{/* Approval and Merge buttons */}
						{readyToMerge && mr.state === "opened" && (
							<div className="flex items-center gap-2">
								<Button
									onClick={handleApprove}
									disabled={isApproving}
									variant="default"
									className="flex-1 bg-success hover:bg-success/90"
								>
									{isApproving ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("gitlab:mrReview.approving")}
										</>
									) : (
										<>
											<CheckCircle className="h-4 w-4 mr-2" />
											{t("gitlab:mrReview.approve")}
										</>
									)}
								</Button>
								<Button
									onClick={handleMerge}
									disabled={isMerging}
									variant="outline"
									className="flex-1"
								>
									{isMerging ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("gitlab:mrReview.merging")}
										</>
									) : (
										<>
											<GitMerge className="h-4 w-4 mr-2" />
											{t("gitlab:mrReview.merge")}
										</>
									)}
								</Button>
							</div>
						)}
					</div>

					{/* MR Review Status Banner */}
					<Card
						className={`border-2 ${statusColor} ${mrStatus.status === "ready_for_followup" ? "animate-pulse-subtle" : ""}`}
					>
						<CardContent className="py-3">
							<div className="flex items-center gap-3">
								<div className={`p-2 rounded-full ${statusColor}`}>
									<StatusIcon className="h-5 w-5" />
								</div>
								<div className="flex-1 min-w-0">
									<div className="font-medium">
										{t(`gitlab:mrReview.status.${mrStatus.status}`)}
									</div>
									<div className="text-sm text-muted-foreground truncate">
										{t(
											`gitlab:mrReview.status.${mrStatus.detail.key}`,
											mrStatus.detail.values ?? {},
										)}
									</div>
								</div>
								{mrStatus.status === "ready_for_followup" && (
									<Button
										onClick={onRunFollowupReview}
										disabled={isReviewing}
										className="bg-info hover:bg-info/90 text-info-foreground shrink-0"
									>
										{isReviewing ? (
											<>
												<Loader2 className="h-4 w-4 mr-2 animate-spin" />
												{t("gitlab:mrReview.reviewing")}
											</>
										) : (
											<>
												<RefreshCw className="h-4 w-4 mr-2" />
												{t("gitlab:mrReview.runFollowup")}
											</>
										)}
									</Button>
								)}
							</div>
						</CardContent>
					</Card>

					{/* Review Progress */}
					{reviewProgress && (
						<Card>
							<CardContent className="pt-4">
								<div className="space-y-2">
									<div className="flex items-center justify-between text-sm">
										<span>{reviewProgress.message}</span>
										<span className="text-muted-foreground">
											{reviewProgress.progress}%
										</span>
									</div>
									<Progress value={reviewProgress.progress} />
								</div>
							</CardContent>
						</Card>
					)}

					{/* Review Result */}
					{reviewResult?.success && (
						<Card>
							<CardHeader className="pb-2">
								<CardTitle className="text-sm flex items-center justify-between">
									<span className="flex items-center gap-2">
										{reviewResult.isFollowupReview ? (
											<RefreshCw className="h-4 w-4" />
										) : (
											<Sparkles className="h-4 w-4" />
										)}
										{reviewResult.isFollowupReview
											? t("gitlab:mrReview.followupReviewResult")
											: t("gitlab:mrReview.aiReviewResult")}
									</span>
									<Badge
										variant="outline"
										className={VERDICT_LOOK[reviewResult.overallStatus].className}
									>
										{t(VERDICT_LOOK[reviewResult.overallStatus].label)}
									</Badge>
								</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4 overflow-hidden">
								{/* Follow-up Review Resolution Status */}
								{reviewResult.isFollowupReview && (
									<div className="flex flex-wrap gap-2 pb-2 border-b border-border">
										{FOLLOWUP_BADGES.map(({ field, label, Icon, className }) => {
											const count = reviewResult[field]?.length ?? 0;
											return (
												count > 0 && (
													<Badge key={field} variant="outline" className={className}>
														<Icon className="h-3 w-3 mr-1" />
														{t(label, { count })}
													</Badge>
												)
											);
										})}
									</div>
								)}

								<p className="text-sm text-muted-foreground break-words">
									{reviewResult.summary}
								</p>

								{/* Interactive Findings with Selection */}
								<ReviewFindings
									findings={reviewResult.findings}
									selectedIds={selectedFindingIds}
									postedIds={postedFindingIds}
									onSelectionChange={setSelectedFindingIds}
								/>

								{reviewResult.reviewedAt && (
									<p className="text-xs text-muted-foreground">
										{t("gitlab:mrReview.reviewedAt", {
											date: formatDate(reviewResult.reviewedAt),
										})}
										{reviewResult.reviewedCommitSha && (
											<>
												{" "}
												{t("gitlab:mrReview.atCommit", {
													sha: reviewResult.reviewedCommitSha.substring(0, 7),
												})}
											</>
										)}
									</p>
								)}
							</CardContent>
						</Card>
					)}

					{/* Review Error */}
					{reviewResult && !reviewResult.success && (
						<Card className="border-destructive">
							<CardContent className="pt-4">
								<div className="flex items-center gap-2 text-destructive">
									<XCircle className="h-4 w-4" />
									<span className="text-sm">{t("gitlab:mrReview.reviewFailed")}</span>
								</div>
							</CardContent>
						</Card>
					)}

					{/* Description */}
					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-sm">{t("gitlab:mrReview.description")}</CardTitle>
						</CardHeader>
						<CardContent className="overflow-hidden">
							{mr.description ? (
								<pre className="whitespace-pre-wrap text-sm text-muted-foreground font-sans break-words max-w-full overflow-hidden">
									{mr.description}
								</pre>
							) : (
								<p className="text-sm text-muted-foreground italic">
									{t("gitlab:mrReview.noDescription")}
								</p>
							)}
						</CardContent>
					</Card>

					{/* Labels */}
					{mr.labels && mr.labels.length > 0 && (
						<Card>
							<CardHeader className="pb-2">
								<CardTitle className="text-sm">{t("gitlab:mrReview.labels")}</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="flex flex-wrap gap-2">
									{mr.labels.map((label) => (
										<Badge key={label} variant="outline">
											{label}
										</Badge>
									))}
								</div>
							</CardContent>
						</Card>
					)}
				</div>
			</ScrollArea>
		</ErrorBoundary>
	);
}
