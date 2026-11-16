import { JevStatus } from "../../jev/JevStatus";
import {
	AlertCircle,
	AlertTriangle,
	Bot,
	CheckCheck,
	CheckCircle,
	Clock,
	ExternalLink,
	FileText,
	GitBranch,
	GitMerge,
	Loader2,
	MessageSquare,
	Play,
	RefreshCw,
	Send,
	XCircle,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
	MergeReadiness,
	NewCommitsCheck,
	PRLogs as PRLogsType,
	WorkflowsAwaitingApprovalResult,
} from "../../../../preload/api/modules/github-api";
import { useQualityScore } from "../../../hooks/use-quality-score";
import { QualityScorePanel } from "../../QualityScorePanel";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { Progress } from "../../ui/progress";
import { ScrollArea } from "../../ui/scroll-area";
import type {
	PRData,
	PRReviewProgress,
	PRReviewResult,
} from "../hooks/useGitHubPRs";
// Local components
import { CollapsibleCard } from "./CollapsibleCard";
import { DeepContextInsights } from "./DeepContextInsights";
import { PRHeader } from "./PRHeader";
import { PRLogs } from "./PRLogs";
import { ReviewFindings } from "./ReviewFindings";
import { ReviewStatusTree } from "./ReviewStatusTree";
import {
	getPRDetailStatus,
	isCleanReview,
	isReadyToMerge,
} from "../utils/pr-detail-status";
import { withUniqueKeys } from "../utils/unique-keys";

interface PRDetailProps {
	pr: PRData;
	projectId: string;
	reviewResult: PRReviewResult | null;
	previousReviewResult: PRReviewResult | null;
	reviewProgress: PRReviewProgress | null;
	startedAt: string | null;
	isReviewing: boolean;
	initialNewCommitsCheck?: NewCommitsCheck | null;
	isLoadingFiles?: boolean;
	onRunReview: () => void;
	onRunFollowupReview: () => void;
	onCheckNewCommits: () => Promise<NewCommitsCheck>;
	onCancelReview: () => void;
	onPostReview: (
		selectedFindingIds?: string[],
		options?: { forceApprove?: boolean },
	) => Promise<boolean>;
	onPostComment: (body: string) => Promise<boolean>;
	onMergePR: (mergeMethod?: "merge" | "squash" | "rebase") => void;
	onGetLogs: () => Promise<PRLogsType | null>;
	onMarkReviewPosted?: (prNumber: number) => Promise<void>;
}

/** The badge of the review's verdict. */
const VERDICT_LOOK: Record<
	PRReviewResult["overallStatus"],
	{ className: string; label: string }
> = {
	approve: {
		className: "bg-success/20 text-success border-success/50",
		label: "prReview.approve",
	},
	request_changes: {
		className: "bg-destructive/20 text-destructive border-destructive/50",
		label: "prReview.changesRequested",
	},
	comment: { className: "bg-muted", label: "prReview.commented" },
};

/** What a follow-up review did with the previous findings. */
const FOLLOWUP_BADGES = [
	{
		field: "resolvedFindings",
		label: "prReview.resolved",
		Icon: CheckCircle,
		className: "bg-success/10 text-success border-success/30",
	},
	{
		field: "unresolvedFindings",
		label: "prReview.stillOpen",
		Icon: AlertCircle,
		className: "bg-warning/10 text-warning border-warning/30",
	},
	{
		field: "newFindingsSinceLastReview",
		label: "prReview.newIssue",
		Icon: XCircle,
		className: "bg-destructive/10 text-destructive border-destructive/30",
	},
] as const;

/**
 * One page per PR: opening another PR starts a fresh page, so nothing posted,
 * loaded or failed on one PR shows on the next, and a post still running for
 * the previous PR cannot write into this one.
 */
export function PRDetail(props: PRDetailProps) {
	return <PRDetailPage key={`${props.projectId}:${props.pr.number}`} {...props} />;
}

function PRDetailPage({
	pr,
	projectId,
	reviewResult,
	previousReviewResult,
	reviewProgress,
	startedAt,
	isReviewing,
	initialNewCommitsCheck,
	isLoadingFiles = false,
	onRunReview,
	onRunFollowupReview,
	onCheckNewCommits,
	onCancelReview,
	onPostReview,
	onPostComment,
	onMergePR,
	onGetLogs,
	onMarkReviewPosted,
}: PRDetailProps) {
	const { t } = useTranslation("common");

	// Quality Score hook
	const qualityScore = useQualityScore();

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
	const [isPosting, setIsPosting] = useState(false);
	const [isPostingCleanReview, setIsPostingCleanReview] = useState(false);
	const [cleanReviewPosted, setCleanReviewPosted] = useState(false);
	const [cleanReviewFailed, setCleanReviewFailed] = useState(false);
	// Blocked status posting state (for BLOCKED/NEEDS_REVISION verdicts with no findings)
	const [isPostingBlockedStatus, setIsPostingBlockedStatus] = useState(false);
	const [blockedStatusPosted, setBlockedStatusPosted] = useState(false);
	const [blockedStatusFailed, setBlockedStatusFailed] = useState(false);
	const [isMerging, setIsMerging] = useState(false);
	// Initialize with store value, then sync and update via local checks
	const [newCommitsCheck, setNewCommitsCheck] =
		useState<NewCommitsCheck | null>(initialNewCommitsCheck ?? null);
	const [analysisExpanded, setAnalysisExpanded] = useState(true);
	const checkNewCommitsAbortRef = useRef<AbortController | null>(null);
	// Ref to track checking state without causing callback recreation
	const isCheckingNewCommitsRef = useRef(false);
	// Logs state
	const [logsExpanded, setLogsExpanded] = useState(false);
	const [prLogs, setPrLogs] = useState<PRLogsType | null>(null);
	const [isLoadingLogs, setIsLoadingLogs] = useState(false);
	const logsLoadedRef = useRef(false);

	// Merge readiness state (real-time validation of AI verdict freshness)
	const [mergeReadiness, setMergeReadiness] = useState<MergeReadiness | null>(
		null,
	);
	const mergeReadinessAbortRef = useRef<AbortController | null>(null);

	// Branch update state (for updating PR branch when behind base)
	const [isUpdatingBranch, setIsUpdatingBranch] = useState(false);
	const [branchUpdateError, setBranchUpdateError] = useState<string | null>(
		null,
	);
	const [branchUpdateSuccess, setBranchUpdateSuccess] = useState(false);

	// Workflows awaiting approval state (for fork PRs)
	const [workflowsAwaiting, setWorkflowsAwaiting] =
		useState<WorkflowsAwaitingApprovalResult | null>(null);
	const [isApprovingWorkflow, setIsApprovingWorkflow] = useState<number | null>(
		null,
	);
	const [workflowsExpanded, setWorkflowsExpanded] = useState(true);

	// Sync with store's newCommitsCheck when it changes (e.g., when switching PRs or after refresh)
	// Always sync to keep local state in sync with store, including null values
	useEffect(() => {
		setNewCommitsCheck(initialNewCommitsCheck ?? null);
	}, [initialNewCommitsCheck]);

	// Sync local postedFindingIds with reviewResult.postedFindingIds when it changes
	useEffect(() => {
		if (reviewResult?.postedFindingIds) {
			setPostedFindingIds(new Set(reviewResult.postedFindingIds));
		} else {
			setPostedFindingIds(new Set());
		}
	}, [reviewResult?.postedFindingIds]);

	// Auto-select ALL findings when review completes (excluding already posted)
	// All findings should reach the contributor - even LOW suggestions are valuable feedback
	useEffect(() => {
		if (reviewResult?.success && reviewResult.findings.length > 0) {
			const allFindings = reviewResult.findings
				.filter((f) => !postedFindingIds.has(f.id))
				.map((f) => f.id);
			setSelectedFindingIds(new Set(allFindings));
		}
	}, [reviewResult, postedFindingIds]);

	// Check for new commits after any review has been completed
	// This allows detecting new work pushed after ANY review (initial or follow-up)
	const hasPostedFindings =
		postedFindingIds.size > 0 || reviewResult?.hasPostedFindings;

	const checkForNewCommits = useCallback(async () => {
		// Prevent duplicate concurrent calls using ref (avoids callback recreation)
		if (isCheckingNewCommitsRef.current) {
			return;
		}

		// Check for new commits if we have ANY successful review with a commit SHA
		// This includes follow-up reviews that resolved all issues (no new findings)
		// New commits = new code that needs to be reviewed, regardless of posting status
		if (!reviewResult?.success || !reviewResult.reviewedCommitSha) {
			return;
		}

		// Skip if we already have a fresh newCommitsCheck from initialNewCommitsCheck (store)
		// that matches the current review's commit SHA. This prevents redundant API calls
		// when the useGitHubPRs hook has already checked for new commits on PR selection.
		// The `lastReviewedCommit` field indicates which commit SHA the check was performed against.
		if (
			newCommitsCheck?.lastReviewedCommit === reviewResult.reviewedCommitSha
		) {
			return;
		}

		// Additional guard: if we have any newCommitsCheck result but it lacks lastReviewedCommit,
		// skip to prevent infinite loops. This handles edge cases where the API returns
		// a result without the tracking field.
		if (newCommitsCheck && !newCommitsCheck.lastReviewedCommit) {
			return;
		}

		// No check is running here (see the ref above); the effect's cleanup
		// aborts this one if the page closes or the review changes.
		checkNewCommitsAbortRef.current = new AbortController();

		isCheckingNewCommitsRef.current = true;
		try {
			const result = await onCheckNewCommits();
			// Only update state if not aborted
			if (!checkNewCommitsAbortRef.current?.signal.aborted) {
				setNewCommitsCheck(result);
			}
		} finally {
			// Always reset the checking ref to allow future checks.
			// The abort only determines whether to update STATE, not whether
			// the operation tracking should be reset.
			isCheckingNewCommitsRef.current = false;
		}
	}, [reviewResult, onCheckNewCommits, newCommitsCheck]);

	useEffect(() => {
		checkForNewCommits();
		return () => {
			// Cleanup abort controller on unmount
			if (checkNewCommitsAbortRef.current) {
				checkNewCommitsAbortRef.current.abort();
			}
		};
	}, [checkForNewCommits]);

	// Clear success message after 3 seconds
	useEffect(() => {
		if (postSuccess) {
			const timer = setTimeout(() => setPostSuccess(null), 3000);
			return () => clearTimeout(timer);
		}
	}, [postSuccess]);

	// Clear branch update success message after 3 seconds
	useEffect(() => {
		if (branchUpdateSuccess) {
			const timer = setTimeout(() => setBranchUpdateSuccess(false), 3000);
			return () => clearTimeout(timer);
		}
	}, [branchUpdateSuccess]);

	// Auto-expand logs section when review starts
	useEffect(() => {
		if (isReviewing) {
			setLogsExpanded(true);
		}
	}, [isReviewing]);

	// Analyze code quality once per reviewed PR and file list. The effect used
	// to depend on the whole hook object, recreated on every render, and the
	// analysis itself re-renders: each run started another Python process.
	const { analyzePR } = qualityScore;
	const qualityAnalyzedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!reviewResult?.success || !pr.files || pr.files.length === 0) return;
		const fileNames = pr.files.map((f) => f.path);
		const key = `${projectId}:${pr.number}:${fileNames.join("\n")}`;
		if (qualityAnalyzedRef.current === key) return;
		qualityAnalyzedRef.current = key;
		analyzePR(pr.number, fileNames, projectId).catch((err) => {
			console.error("Failed to analyze quality:", err);
		});
	}, [reviewResult?.success, pr.number, pr.files, projectId, analyzePR]);

	// Load logs when logs section is expanded or when reviewing (for live logs)
	useEffect(() => {
		if (logsExpanded && !logsLoadedRef.current && !isLoadingLogs) {
			logsLoadedRef.current = true;
			setIsLoadingLogs(true);
			onGetLogs()
				.then((logs) => setPrLogs(logs))
				.catch(() => setPrLogs(null))
				.finally(() => setIsLoadingLogs(false));
		}
	}, [logsExpanded, onGetLogs, isLoadingLogs]);

	// Track previous reviewing state to detect transitions
	const wasReviewingRef = useRef(false);

	// Refresh logs periodically while reviewing (even faster during active review)
	useEffect(() => {
		const wasReviewing = wasReviewingRef.current;
		wasReviewingRef.current = isReviewing;

		// Do one final refresh when review just completed to get final phase status
		if (wasReviewing && !isReviewing) {
			onGetLogs()
				.then((logs) => setPrLogs(logs))
				.catch((err) => console.error("Failed to fetch final logs:", err));
			return;
		}

		// Clear old logs when a new review starts to avoid showing stale status
		if (!wasReviewing && isReviewing) {
			setPrLogs(null);
		}

		if (!isReviewing) return;

		const refreshLogs = async () => {
			try {
				const logs = await onGetLogs();
				setPrLogs(logs);
			} catch {
				// Ignore errors during refresh
			}
		};

		// Refresh immediately, then every 1.5 seconds while reviewing for smoother streaming
		refreshLogs();
		const interval = setInterval(refreshLogs, 1500);
		return () => clearInterval(interval);
	}, [isReviewing, onGetLogs]);

	// Fork PRs: the runs GitHub holds until a maintainer approves them.
	const loadWorkflowsAwaiting = useCallback(async () => {
		try {
			setWorkflowsAwaiting(
				await window.electronAPI.github.getWorkflowsAwaitingApproval(
					projectId,
					pr.number,
				),
			);
		} catch {
			setWorkflowsAwaiting(null);
		}
	}, [projectId, pr.number]);

	useEffect(() => {
		void loadWorkflowsAwaiting();
	}, [loadWorkflowsAwaiting]);

	// Merge readiness: GitHub's live view of the PR, which can contradict an
	// older AI verdict. Read when the page opens and after a branch update.
	const checkMergeReadiness = useCallback(async () => {
		mergeReadinessAbortRef.current?.abort();
		const controller = new AbortController();
		mergeReadinessAbortRef.current = controller;
		if (!projectId) {
			setMergeReadiness(null);
			return;
		}
		let result: MergeReadiness | null = null;
		try {
			result = await window.electronAPI.github.checkMergeReadiness(
				projectId,
				pr.number,
			);
		} catch {
			result = null;
		}
		if (!controller.signal.aborted) setMergeReadiness(result);
	}, [pr.number, projectId]);

	useEffect(() => {
		void checkMergeReadiness();
		return () => mergeReadinessAbortRef.current?.abort();
	}, [checkMergeReadiness]);

	const handleApproveWorkflow = useCallback(
		async (runId: number) => {
			setIsApprovingWorkflow(runId);
			try {
				if (await window.electronAPI.github.approveWorkflow(projectId, runId)) {
					await loadWorkflowsAwaiting();
				}
			} finally {
				setIsApprovingWorkflow(null);
			}
		},
		[projectId, loadWorkflowsAwaiting],
	);

	const handleApproveAllWorkflows = useCallback(
		async (runs: readonly { id: number }[]) => {
		for (const workflow of runs) {
			setIsApprovingWorkflow(workflow.id);
			try {
				await window.electronAPI.github.approveWorkflow(projectId, workflow.id);
			} catch {
				// One refused run does not stop the others.
			}
		}
		setIsApprovingWorkflow(null);
		await loadWorkflowsAwaiting();
		},
		[projectId, loadWorkflowsAwaiting],
	);

	const handleUpdateBranch = useCallback(async () => {
		setIsUpdatingBranch(true);
		setBranchUpdateError(null);
		setBranchUpdateSuccess(false);
		try {
			const result = await window.electronAPI.github.updatePRBranch(
				projectId,
				pr.number,
			);
			if (result.success) {
				setBranchUpdateSuccess(true);
				// The warning was about this branch: read GitHub's view again.
				void checkMergeReadiness();
			} else {
				setBranchUpdateError(result.error || t("prReview.branchUpdateFailed"));
			}
		} catch (err) {
			setBranchUpdateError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsUpdatingBranch(false);
		}
	}, [pr.number, projectId, t, checkMergeReadiness]);

	// Count selected findings by type for the button label
	const selectedCount = selectedFindingIds.size;

	const readyToMerge = isReadyToMerge(reviewResult);

	const cleanReview = isCleanReview(reviewResult);

	// Get LOW severity findings for auto-posting
	const lowSeverityFindings = useMemo(() => {
		if (!reviewResult?.findings) return [];
		return reviewResult.findings.filter((f) => f.severity === "low");
	}, [reviewResult]);

	const prStatus = getPRDetailStatus({
		isReviewing,
		result: reviewResult,
		postedIds: postedFindingIds,
		newCommitsCheck,
	});

	// The page belongs to one PR (see PRDetail), so a post that ends after
	// another PR was opened only updates a page no longer shown.
	const handlePostReview = async () => {
		const idsToPost = Array.from(selectedFindingIds);
		setIsPostingFindings(true);
		try {
			if (await onPostReview(idsToPost)) {
				setPostedFindingIds((prev) => new Set([...prev, ...idsToPost]));
				setSelectedFindingIds(new Set());
				setPostSuccess({ count: idsToPost.length, timestamp: Date.now() });
				// Posting opens the follow-up: give the backend a moment to save
				// the posted state, then look for new commits.
				setTimeout(() => checkForNewCommits(), 500);
			}
		} finally {
			setIsPostingFindings(false);
		}
	};

	// Comments posted on GitHub are in English, the common language of code
	// review there; the app's own text follows the app's language.
	const handleApprove = async (summary: string) => {
		setIsPosting(true);
		try {
			await onPostComment(
				`## ✅ WorkPilot AI PR Review - APPROVED\n\n${summary}\n\n---\n*This approval was generated by WorkPilot AI.*`,
			);
		} finally {
			setIsPosting(false);
		}
	};

	// Approves a clean PR, its LOW findings attached as suggestions, in one review.
	const handleAutoApprove = async () => {
		const lowFindingIds = lowSeverityFindings.map((f) => f.id);
		setIsPosting(true);
		try {
			if (await onPostReview(lowFindingIds, { forceApprove: true })) {
				setPostedFindingIds((prev) => new Set([...prev, ...lowFindingIds]));
			}
		} finally {
			setIsPosting(false);
		}
	};

	// A comment that says the review found nothing to change; the PR's review
	// status on GitHub stays as it is.
	const handlePostCleanReview = async (summary: string) => {
		setIsPostingCleanReview(true);
		setCleanReviewFailed(false);
		const posted = await onPostComment(
			[
				t("prReview.cleanReviewMessageTitle"),
				t("prReview.cleanReviewMessageStatus"),
				summary,
				"---",
				t("prReview.cleanReviewMessageFooter"),
			].join("\n\n"),
		).catch(() => false);
		// A comment GitHub refused used to be reported as posted.
		setCleanReviewPosted(posted);
		setCleanReviewFailed(!posted);
		setIsPostingCleanReview(false);
	};

	// A request-changes verdict with no finding to post (the findings could not
	// be read): the summary, which names the blockers, goes out as a comment.
	const handlePostBlockedStatus = async (summary: string) => {
		setIsPostingBlockedStatus(true);
		setBlockedStatusFailed(false);
		const posted = await onPostComment(
			[
				t("prReview.blockedStatusMessageTitle"),
				summary,
				"---",
				t("prReview.blockedStatusMessageFooter"),
			].join("\n\n"),
		).catch(() => false);
		setBlockedStatusPosted(posted);
		setBlockedStatusFailed(!posted);
		setIsPostingBlockedStatus(false);
		// The PR list shows the review as posted.
		if (posted) await onMarkReviewPosted?.(pr.number);
	};

	const handleMerge = async () => {
		setIsMerging(true);
		try {
			await onMergePR("squash"); // Default to squash merge
		} finally {
			setIsMerging(false);
		}
	};

	return (
		<ScrollArea className="flex-1">
			<div className="p-6 max-w-5xl mx-auto space-y-6">
				<JevStatus
					projectId={projectId}
					workflow="github-review"
					observation={reviewResult?.jev}
				/>
				{/* Refactored Header */}
				<PRHeader pr={pr} isLoadingFiles={isLoadingFiles} />

				{/* Merge Readiness Warning Banner - shows when real-time status contradicts AI verdict */}
				{mergeReadiness &&
					mergeReadiness.blockers.length > 0 &&
					reviewResult?.success &&
					(prStatus === "ready_to_merge" ||
						prStatus === "reviewed_pending_post") && (
						<Card className="border-warning/50 bg-warning/10 animate-in fade-in slide-in-from-top-2 duration-300">
							<CardContent className="py-4">
								<div className="flex items-start gap-3">
									<AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
									<div className="flex-1 space-y-2">
										<p className="font-semibold text-warning">
											{t(
												"prReview.verdictOutdated",
												"AI verdict may be outdated",
											)}
										</p>
										<ul className="text-sm text-warning/90 space-y-1">
											{withUniqueKeys(mergeReadiness.blockers, (b) => b).map(
												({ key, item: blocker }) => (
													<li key={key} className="flex items-center gap-2">
														<span className="h-1.5 w-1.5 rounded-full bg-warning/70" />
														{blocker}
													</li>
												),
											)}
										</ul>
										{mergeReadiness.isBehind && (
											<div className="flex items-center gap-3 mt-3">
												<Button
													size="sm"
													variant="outline"
													className="border-warning/50 text-warning hover:bg-warning/20"
													onClick={handleUpdateBranch}
													disabled={isUpdatingBranch}
												>
													{isUpdatingBranch ? (
														<>
															<Loader2 className="h-4 w-4 mr-2 animate-spin" />
															{t("prReview.updatingBranch")}
														</>
													) : (
														<>
															<GitBranch className="h-4 w-4 mr-2" />
															{t("prReview.updateBranch")}
														</>
													)}
												</Button>
											</div>
										)}
										<p className="text-xs text-warning/70 mt-2">
											{t(
												"prReview.rerunReviewSuggestion",
												"Consider re-running the review after resolving these issues.",
											)}
										</p>
									</div>
								</div>
							</CardContent>
						</Card>
					)}

				{branchUpdateSuccess && (
					<div className="flex items-center gap-2 text-xs text-success animate-in fade-in duration-200">
						<CheckCircle className="h-3 w-3" />
						{t("prReview.branchUpdated")}
					</div>
				)}
				{branchUpdateError && (
					<div className="text-xs text-destructive animate-in fade-in duration-200">
						{branchUpdateError}
					</div>
				)}

				{/* Code Quality Score - show after review completes */}
				{qualityScore.score && reviewResult?.success && (
					<div className="animate-in fade-in slide-in-from-top-2 duration-300">
						<QualityScorePanel
							score={qualityScore.score}
							isLoading={qualityScore.isLoading}
						/>
					</div>
				)}

				{/* Review Status & Actions */}
				<ReviewStatusTree
					status={prStatus}
					isReviewing={isReviewing}
					startedAt={startedAt}
					reviewResult={reviewResult}
					previousReviewResult={previousReviewResult}
					postedCount={
						new Set([
							...postedFindingIds,
							...(reviewResult?.postedFindingIds ?? []),
						]).size
					}
					onRunReview={onRunReview}
					onRunFollowupReview={onRunFollowupReview}
					onCancelReview={onCancelReview}
					newCommitsCheck={newCommitsCheck}
					lastPostedAt={
						postSuccess?.timestamp ||
						(reviewResult?.postedAt
							? new Date(reviewResult.postedAt).getTime()
							: null)
					}
				/>

				{/* Action Bar (Legacy Actions that fit under the tree context) */}
				{reviewResult?.success && !isReviewing && (
					<div className="flex flex-wrap items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
						{selectedCount > 0 && (
							<Button
								onClick={handlePostReview}
								variant="secondary"
								disabled={isPostingFindings}
								className="flex-1 sm:flex-none"
							>
								{isPostingFindings ? (
									<>
										<Loader2 className="h-4 w-4 mr-2 animate-spin" />
										{t("prReview.posting")}
									</>
								) : (
									<>
										<Send className="h-4 w-4 mr-2" />
										{t("prReview.postFindings", { count: selectedCount })}
									</>
								)}
							</Button>
						)}

						{/* Post Clean Review button - shows when review is clean and no findings are selected */}
						{selectedCount === 0 &&
							cleanReview &&
							!hasPostedFindings &&
							!cleanReviewPosted &&
							reviewResult?.overallStatus !== "request_changes" && (
								<Button
									onClick={() => handlePostCleanReview(reviewResult.summary)}
									disabled={isPostingCleanReview || isPosting}
									variant="secondary"
									className="flex-1 sm:flex-none"
								>
									{isPostingCleanReview ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("prReview.postingCleanReview")}
										</>
									) : (
										<>
											<MessageSquare className="h-4 w-4 mr-2" />
											{t("prReview.postCleanReview")}
										</>
									)}
								</Button>
							)}

						{/* Post Blocked Status button - shows when verdict is BLOCKED/NEEDS_REVISION but no findings */}
						{/* This handles the edge case where structured output parsing fails but we still have a verdict */}
						{selectedCount === 0 &&
							!hasPostedFindings &&
							!blockedStatusPosted &&
							reviewResult?.overallStatus === "request_changes" && (
								<Button
									onClick={() => handlePostBlockedStatus(reviewResult.summary)}
									disabled={isPostingBlockedStatus || isPosting}
									variant="secondary"
									className="flex-1 sm:flex-none"
								>
									{isPostingBlockedStatus ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("prReview.postingBlockedStatus")}
										</>
									) : (
										<>
											<AlertTriangle className="h-4 w-4 mr-2" />
											{t("prReview.postBlockedStatus")}
										</>
									)}
								</Button>
							)}

						{/* Approve button - consolidated logic to avoid duplicate buttons */}
						{/* Don't show when overallStatus is 'request_changes' (e.g., workflows blocked, or other issues) */}
						{cleanReview &&
							!hasPostedFindings &&
							reviewResult?.overallStatus !== "request_changes" && (
								<Button
									onClick={handleAutoApprove}
									disabled={isPosting || isPostingCleanReview}
									variant="default"
									className="flex-1 sm:flex-none bg-success hover:bg-success/90 text-success-foreground"
								>
									{isPosting ? (
										<>
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
											{t("prReview.postingApproval")}
										</>
									) : (
										<>
											<CheckCheck className="h-4 w-4 mr-2" />
											{t("prReview.autoApprovePR")}
											{lowSeverityFindings.length > 0 && (
												<span className="ml-1 text-xs opacity-80">
													{t("prReview.suggestions", {
														count: lowSeverityFindings.length,
													})}
												</span>
											)}
										</>
									)}
								</Button>
							)}

						{/* Manual approve button - only show for non-clean reviews that are ready to merge */}
						{readyToMerge && !cleanReview && !hasPostedFindings && (
							<Button
								onClick={() => handleApprove(reviewResult.summary)}
								disabled={isPosting}
								variant="default"
								className="flex-1 sm:flex-none bg-success hover:bg-success/90 text-success-foreground"
							>
								{isPosting ? (
									<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								) : (
									<CheckCircle className="h-4 w-4 mr-2" />
								)}
								{t("prReview.approve")}
							</Button>
						)}

						{/* Merge button - only show after approval has been posted */}
						{hasPostedFindings && (
							<Button
								onClick={handleMerge}
								disabled={isMerging}
								variant="outline"
								className="flex-1 sm:flex-none gap-1.5 text-muted-foreground hover:text-foreground"
								title={t("prReview.mergeViaGitHub")}
							>
								{isMerging ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<>
										<GitMerge className="h-4 w-4" />
										<span>{t("prReview.merge")}</span>
										<ExternalLink className="h-3 w-3 opacity-50" />
									</>
								)}
							</Button>
						)}

						{postSuccess && (
							<div className="ml-auto flex items-center gap-2 text-success text-sm font-medium animate-pulse">
								<CheckCircle className="h-4 w-4" />
								{t("prReview.postedFindings", { count: postSuccess.count })}
							</div>
						)}

						{cleanReviewPosted && !postSuccess && (
							<div className="ml-auto flex items-center gap-2 text-success text-sm font-medium animate-pulse">
								<CheckCircle className="h-4 w-4" />
								{t("prReview.cleanReviewPosted")}
							</div>
						)}

						{cleanReviewFailed && (
							<div className="ml-auto flex items-center gap-2 text-destructive text-sm font-medium">
								<XCircle className="h-4 w-4" />
								{t("prReview.failedPostCleanReview")}
							</div>
						)}

						{/* Blocked status posted success message */}
						{blockedStatusPosted && !postSuccess && !cleanReviewPosted && (
							<div className="ml-auto flex items-center gap-2 text-warning text-sm font-medium animate-pulse">
								<CheckCircle className="h-4 w-4" />
								{t("prReview.blockedStatusPosted")}
							</div>
						)}

						{/* Blocked status error display */}
						{blockedStatusFailed && (
							<div className="ml-auto flex items-center gap-2 text-destructive text-sm font-medium">
								<XCircle className="h-4 w-4" />
								{t("prReview.failedPostBlockedStatus")}
							</div>
						)}
					</div>
				)}

				{/* Review Progress */}
				{reviewProgress && (
					<div className="space-y-2">
						<div className="flex items-center justify-between text-sm">
							<span className="font-medium">{reviewProgress.message}</span>
							<span className="text-muted-foreground">
								{reviewProgress.progress}%
							</span>
						</div>
						<Progress value={reviewProgress.progress} className="h-2" />
					</div>
				)}

				{/* Review Result / Findings */}
				{reviewResult?.success && (
					<CollapsibleCard
						title={
							reviewResult.isFollowupReview
								? t("prReview.followupReviewDetails")
								: t("prReview.aiAnalysisResults")
						}
						icon={
							reviewResult.isFollowupReview ? (
								<RefreshCw className="h-4 w-4 text-blue-500" />
							) : (
								<Bot className="h-4 w-4 text-purple-500" />
							)
						}
						badge={
							<Badge
								variant="outline"
								className={VERDICT_LOOK[reviewResult.overallStatus].className}
							>
								{t(VERDICT_LOOK[reviewResult.overallStatus].label)}
							</Badge>
						}
						open={analysisExpanded}
						onOpenChange={setAnalysisExpanded}
					>
						<div className="p-4 space-y-6">
							{/* Follow-up Review Resolution Status */}
							{reviewResult.isFollowupReview && (
								<div className="flex flex-wrap items-center gap-3 pb-4 border-b border-border/50">
									{FOLLOWUP_BADGES.map(({ field, label, Icon, className }) => {
										const count = reviewResult[field]?.length ?? 0;
										return (
											count > 0 && (
												<Badge
													key={field}
													variant="outline"
													className={`${className} px-3 py-1`}
												>
													<Icon className="h-3.5 w-3.5 mr-1.5" />
													{t(label, { count })}
												</Badge>
											)
										);
									})}
									{/* Re-run follow-up review button */}
									<Button
										variant="ghost"
										size="sm"
										className="h-7 px-2 ml-auto text-muted-foreground hover:text-foreground"
										onClick={onRunFollowupReview}
										disabled={isReviewing}
										title={t("prReview.rerunFollowup")}
									>
										{isReviewing ? (
											<Loader2 className="h-3.5 w-3.5 animate-spin" />
										) : (
											<RefreshCw className="h-3.5 w-3.5" />
										)}
									</Button>
								</div>
							)}

							<div className="bg-muted/30 p-4 rounded-lg text-sm text-muted-foreground leading-relaxed">
								{reviewResult.summary}
							</div>

							{/* Interactive Findings with Selection */}
							<ReviewFindings
								findings={reviewResult.findings}
								selectedIds={selectedFindingIds}
								postedIds={postedFindingIds}
								onSelectionChange={setSelectedFindingIds}
								projectId={projectId}
								prNumber={pr.number}
								learnedSuppressions={reviewResult.learnedSuppressions}
							/>
						</div>
					</CollapsibleCard>
				)}

				{/* Deep Codebase Context */}
				{reviewResult?.success &&
					reviewResult.deepContext?.contextAvailable && (
						<DeepContextInsights deepContext={reviewResult.deepContext} />
					)}

				{/* Review Error */}
				{reviewResult && !reviewResult.success && reviewResult.error && (
					<Card className="border-destructive/50 bg-destructive/5">
						<CardContent className="pt-6">
							<div className="flex items-start gap-3 text-destructive">
								<XCircle className="h-5 w-5 mt-0.5" />
								<div className="space-y-1">
									<p className="font-semibold">{t("prReview.reviewFailed")}</p>
									<p className="text-sm opacity-90">{reviewResult.error}</p>
								</div>
							</div>
						</CardContent>
					</Card>
				)}

				{/* Workflows Awaiting Approval - for fork PRs */}
				{workflowsAwaiting && workflowsAwaiting.awaiting_approval > 0 && (
					<CollapsibleCard
						title={t("prReview.workflowsAwaitingApproval", {
							count: workflowsAwaiting.awaiting_approval,
						})}
						icon={<Clock className="h-4 w-4 text-warning" />}
						badge={
							<Badge
								variant="outline"
								className="text-xs bg-warning/10 text-warning border-warning/30"
							>
								<AlertTriangle className="h-3 w-3 mr-1" />
								{t("prReview.blockedByWorkflows")}
							</Badge>
						}
						open={workflowsExpanded}
						onOpenChange={setWorkflowsExpanded}
					>
						<div className="p-4 space-y-4">
							<p className="text-sm text-muted-foreground">
								{t("prReview.workflowsAwaitingDescription")}
							</p>

							<div className="space-y-2">
								{workflowsAwaiting.workflow_runs.map((workflow) => (
									<div
										key={workflow.id}
										className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border border-border/50"
									>
										<div className="flex items-center gap-2 min-w-0">
											<Clock className="h-4 w-4 text-warning shrink-0" />
											<div className="min-w-0">
												<span className="text-sm font-medium truncate block">
													{workflow.workflow_name}
												</span>
												<span className="text-xs text-muted-foreground">
													{workflow.name}
												</span>
											</div>
										</div>
										<div className="flex items-center gap-2 shrink-0">
											<Button
												size="sm"
												variant="outline"
												className="h-7 text-xs"
												onClick={() => window.open(workflow.html_url, "_blank")}
											>
												<ExternalLink className="h-3 w-3 mr-1" />
												{t("prReview.viewOnGitHub")}
											</Button>
											<Button
												size="sm"
												variant="default"
												className="h-7 text-xs"
												onClick={() => handleApproveWorkflow(workflow.id)}
												disabled={isApprovingWorkflow !== null}
											>
												{isApprovingWorkflow === workflow.id ? (
													<Loader2 className="h-3 w-3 animate-spin" />
												) : (
													<>
														<Play className="h-3 w-3 mr-1" />
														{t("prReview.approveWorkflow")}
													</>
												)}
											</Button>
										</div>
									</div>
								))}
							</div>

							{workflowsAwaiting.workflow_runs.length > 1 && (
								<div className="flex justify-end pt-2 border-t border-border/50">
									<Button
										size="sm"
										variant="default"
										onClick={() =>
											handleApproveAllWorkflows(workflowsAwaiting.workflow_runs)
										}
										disabled={isApprovingWorkflow !== null}
									>
										{isApprovingWorkflow !== null ? (
											<Loader2 className="h-4 w-4 mr-2 animate-spin" />
										) : (
											<Play className="h-4 w-4 mr-2" />
										)}
										{t("prReview.approveAllWorkflows")}
									</Button>
								</div>
							)}
						</div>
					</CollapsibleCard>
				)}

				{/* Review Logs - show during review or after completion */}
				{(reviewResult || isReviewing) && (
					<CollapsibleCard
						title={t("prReview.reviewLogs")}
						icon={<FileText className="h-4 w-4 text-muted-foreground" />}
						badge={
							isReviewing ? (
								<Badge
									variant="outline"
									className="text-xs bg-blue-500/10 text-blue-500 border-blue-500/30"
								>
									<Loader2 className="h-3 w-3 mr-1 animate-spin" />
									{t("prReview.aiReviewInProgress")}
								</Badge>
							) : prLogs ? (
								<Badge variant="outline" className="text-xs">
									{prLogs.is_followup
										? t("prReview.followup")
										: t("prReview.initial")}
								</Badge>
							) : null
						}
						open={logsExpanded}
						onOpenChange={setLogsExpanded}
					>
						<PRLogs
							prNumber={pr.number}
							logs={prLogs}
							isLoading={isLoadingLogs}
							isStreaming={isReviewing}
						/>
					</CollapsibleCard>
				)}

				{/* Description */}
				<Card>
					<CardContent className="pt-6">
						<h3 className="text-sm font-medium text-muted-foreground mb-2">
							{t("prReview.description")}
						</h3>
						<ScrollArea className="h-[400px] w-full rounded-md border p-4 bg-muted/10">
							{pr.body ? (
								<pre className="whitespace-pre-wrap text-sm text-muted-foreground font-sans wrap-break-word">
									{pr.body}
								</pre>
							) : (
								<p className="text-sm text-muted-foreground italic">
									{t("prReview.noDescription")}
								</p>
							)}
						</ScrollArea>
					</CardContent>
				</Card>
			</div>
		</ScrollArea>
	);
}
