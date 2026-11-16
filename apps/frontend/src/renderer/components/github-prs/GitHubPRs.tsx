import {
	ExternalLink,
	GitPullRequest,
	RefreshCw,
	Settings,
} from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import { Button } from "../ui/button";
import { ResizablePanels } from "../ui/resizable-panels";
import { PRDetail, PRFilterBar, PRList } from "./components";
import { useGitHubPRs, usePRFiltering } from "./hooks";
import type { PRData } from "./hooks/useGitHubPRs";
import { EmptyState as SharedEmptyState } from "../ui/empty-state";

interface GitHubPRsProps {
	onOpenSettings?: () => void;
	isActive?: boolean;
}

function NotConnectedState({
	error,
	onOpenSettings,
	t,
}: {
	error: string | null;
	onOpenSettings?: () => void;
	t: (key: string) => string;
}) {
	return (
		<SharedEmptyState
			icon={GitPullRequest}
			title={t("prReview.notConnected")}
			description={error || t("prReview.connectPrompt")}
			action={
				onOpenSettings && (
					<Button onClick={onOpenSettings} variant="outline">
						<Settings className="h-4 w-4 mr-2" />
						{t("prReview.openSettings")}
					</Button>
				)
			}
		/>
	);
}

function EmptyState({ message }: { message: string }) {
	return <SharedEmptyState icon={GitPullRequest} description={message} />;
}

type PRReview = ReturnType<typeof useGitHubPRs>;

/**
 * The selected PR's page. Its actions are bound to that PR here, so none of
 * them has to wonder whether a PR is selected.
 */
function SelectedPRDetail({
	pr,
	projectId,
	review,
}: {
	readonly pr: PRData;
	readonly projectId: string;
	readonly review: PRReview;
}) {
	const prNumber = pr.number;
	const {
		runReview,
		runFollowupReview,
		checkNewCommits,
		cancelReview,
		postReview,
		postComment,
		mergePR,
		markReviewPosted,
	} = review;

	const onRunReview = useCallback(() => runReview(prNumber), [prNumber, runReview]);
	const onRunFollowupReview = useCallback(
		() => runFollowupReview(prNumber),
		[prNumber, runFollowupReview],
	);
	const onCheckNewCommits = useCallback(
		() => checkNewCommits(prNumber),
		[prNumber, checkNewCommits],
	);
	const onCancelReview = useCallback(
		() => cancelReview(prNumber),
		[prNumber, cancelReview],
	);
	const onPostReview = useCallback(
		(ids?: string[], options?: { forceApprove?: boolean }) =>
			postReview(prNumber, ids, options),
		[prNumber, postReview],
	);
	const onPostComment = useCallback(
		(body: string) => postComment(prNumber, body),
		[prNumber, postComment],
	);
	const onMergePR = useCallback(
		(method?: "merge" | "squash" | "rebase") => mergePR(prNumber, method),
		[prNumber, mergePR],
	);
	const onGetLogs = useCallback(
		() => window.electronAPI.github.getPRLogs(projectId, prNumber),
		[projectId, prNumber],
	);

	return (
		<PRDetail
			pr={pr}
			projectId={projectId}
			reviewResult={review.reviewResult}
			previousReviewResult={review.previousReviewResult}
			reviewProgress={review.reviewProgress}
			startedAt={review.startedAt}
			isReviewing={review.isReviewing}
			initialNewCommitsCheck={
				review.getReviewStateForPR(prNumber)?.newCommitsCheck ?? null
			}
			isLoadingFiles={review.isLoadingPRDetails}
			onRunReview={onRunReview}
			onRunFollowupReview={onRunFollowupReview}
			onCheckNewCommits={onCheckNewCommits}
			onCancelReview={onCancelReview}
			onPostReview={onPostReview}
			onPostComment={onPostComment}
			onMergePR={onMergePR}
			onGetLogs={onGetLogs}
			onMarkReviewPosted={markReviewPosted}
		/>
	);
}

export function GitHubPRs({
	onOpenSettings,
	isActive = false,
}: GitHubPRsProps) {
	const { t } = useTranslation("common");
	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	const review = useGitHubPRs(selectedProject?.id, { isActive });
	const {
		prs,
		isLoading,
		isLoadingMore,
		error,
		selectedPRNumber,
		hasMore,
		selectPR,
		refresh,
		loadMore,
		isConnected,
		repoFullName,
		getReviewStateForPR,
		selectedPR,
	} = review;

	// PR filtering
	const {
		filteredPRs,
		contributors,
		filters,
		setSearchQuery,
		setContributors,
		setStatuses,
		setSortBy,
		clearFilters,
		hasActiveFilters,
	} = usePRFiltering(prs, getReviewStateForPR);

	// Not connected state
	if (!isConnected || !selectedProject) {
		return (
			<NotConnectedState error={error} onOpenSettings={onOpenSettings} t={t} />
		);
	}

	return (
		<div className="flex-1 flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-border">
				<div className="flex items-center gap-3">
					<h2 className="text-sm font-medium flex items-center gap-2">
						<GitPullRequest className="h-4 w-4" />
						{t("prReview.pullRequests")}
					</h2>
					{repoFullName && (
						<a
							href={`https://github.com/${repoFullName}/pulls`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
						>
							{repoFullName}
							<ExternalLink className="h-3 w-3" />
						</a>
					)}
					<span className="text-xs text-muted-foreground">
						{t("prReview.openCount", { count: prs.length })}
					</span>
				</div>
				<Button
					variant="ghost"
					size="icon"
					onClick={refresh}
					disabled={isLoading}
					aria-label={t("accessibility.refreshAriaLabel")}
				>
					<RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
				</Button>
			</div>

			{/* Content - Resizable split panels */}
			<ResizablePanels
				defaultLeftWidth={50}
				minLeftWidth={30}
				maxLeftWidth={70}
				storageKey="github-prs-panel-width"
				leftPanel={
					<div className="flex flex-col h-full">
						<PRFilterBar
							filters={filters}
							contributors={contributors}
							hasActiveFilters={hasActiveFilters}
							onSearchChange={setSearchQuery}
							onContributorsChange={setContributors}
							onStatusesChange={setStatuses}
							onSortChange={setSortBy}
							onClearFilters={clearFilters}
						/>
						<PRList
							prs={filteredPRs}
							selectedPRNumber={selectedPRNumber}
							isLoading={isLoading}
							hasMore={hasMore}
							error={error}
							getReviewStateForPR={getReviewStateForPR}
							onSelectPR={selectPR}
							onLoadMore={loadMore}
							isLoadingMore={isLoadingMore}
							isFiltered={hasActiveFilters}
						/>
					</div>
				}
				rightPanel={
					selectedPR ? (
						<SelectedPRDetail
							pr={selectedPR}
							projectId={selectedProject.id}
							review={review}
						/>
					) : (
						<EmptyState message={t("prReview.selectPRToView")} />
					)
				}
			/>
		</div>
	);
}

export default GitHubPRs;
