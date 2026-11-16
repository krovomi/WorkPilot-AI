import { Clock, FileDiff, GitPullRequest, Loader2, User } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import type { PRData } from "../hooks/useGitHubPRs";
import {
	getPRReviewStatus,
	type PRReviewInfo,
	type PRReviewStatus,
} from "../utils/pr-review-status";
import { formatAppDate } from "@/lib/date-format";

/**
 * Status Flow Dots Component
 * Shows 3-dot progression with status label: ● ● ● Ready to Merge
 *
 * - Not started: ○ ○ ○ (gray, no label)
 * - Reviewing: ● ○ ○ Reviewing (amber, animated)
 * - Reviewed (pending post): ● ● ○ Pending Post (blue)
 * - Posted: ● ● ● [Status] (final status color + label)
 */
const DOT = "h-2 w-2 rounded-full transition-all duration-300";
const IDLE = "bg-muted-foreground/30";
const POSTED = ["bg-warning", "bg-blue-400"] as const;

const STATUS_FLOW: Record<
	PRReviewStatus,
	{ dots: readonly [string, string, string]; label?: string; text?: string }
> = {
	not_reviewed: { dots: [IDLE, IDLE, IDLE] },
	reviewing: {
		dots: ["bg-warning animate-pulse", IDLE, IDLE],
		label: "prReview.reviewing",
		text: "text-warning",
	},
	reviewed: {
		dots: ["bg-warning", "bg-blue-400", IDLE],
		label: "prReview.pendingPost",
		text: "text-blue-400",
	},
	ready_to_merge: {
		dots: [...POSTED, "bg-success"],
		label: "prReview.readyToMerge",
		text: "text-success",
	},
	changes_requested: {
		dots: [...POSTED, "bg-destructive"],
		label: "prReview.changesRequested",
		text: "text-destructive",
	},
	ready_for_followup: {
		dots: [...POSTED, "bg-cyan-400"],
		label: "prReview.readyForFollowup",
		text: "text-cyan-400",
	},
};

function PRStatusFlow({ status }: { readonly status: PRReviewStatus }) {
	const { t } = useTranslation("common");
	const { dots, label, text } = STATUS_FLOW[status];
	return (
		<div className="flex items-center gap-1.5">
			<div className="flex items-center gap-1">
				<div className={cn(DOT, dots[0])} />
				<div className={cn(DOT, dots[1])} />
				<div className={cn(DOT, dots[2])} />
			</div>
			{label && (
				<span className={cn("text-xs font-medium", text)}>{t(label)}</span>
			)}
		</div>
	);
}

interface PRListProps {
	prs: PRData[];
	selectedPRNumber: number | null;
	isLoading: boolean;
	hasMore: boolean; // True when 100 PRs returned (GitHub limit) - more may exist
	error: string | null;
	getReviewStateForPR: (prNumber: number) => PRReviewInfo | null;
	onSelectPR: (prNumber: number) => void;
	/** Callback to load more PRs when hasMore is true */
	onLoadMore: () => void;
	/** Whether additional PRs are currently being loaded */
	isLoadingMore: boolean;
	/** The list is narrowed by a search or a filter. */
	isFiltered: boolean;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When the PR last moved, in the app's language. */
function formatUpdated(dateString: string, t: TFunction): string {
	const date = new Date(dateString);
	// A clock slightly ahead of this one must not read "-2m ago".
	const diffMs = Math.max(0, Date.now() - date.getTime());
	const diffDays = Math.floor(diffMs / DAY);

	if (diffDays === 0) {
		const diffHours = Math.floor(diffMs / HOUR);
		if (diffHours === 0) {
			return t("time.minutesAgo", { count: Math.floor(diffMs / MINUTE) });
		}
		return t("time.hoursAgo", { count: diffHours });
	}
	if (diffDays === 1) return t("time.yesterday");
	if (diffDays < 7) return t("time.daysAgo", { count: diffDays });
	if (diffDays < 30) return t("time.weeksAgo", { count: Math.floor(diffDays / 7) });
	return formatAppDate(date);
}

export function PRList({
	prs,
	selectedPRNumber,
	isLoading,
	hasMore,
	error,
	getReviewStateForPR,
	onSelectPR,
	onLoadMore,
	isLoadingMore,
	isFiltered,
}: PRListProps) {
	const { t } = useTranslation("common");

	if (isLoading && prs.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="text-center text-muted-foreground">
					<GitPullRequest className="h-8 w-8 mx-auto mb-2 animate-pulse" />
					<p>{t("prReview.loadingPRs")}</p>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex-1 flex items-center justify-center p-4">
				<div className="text-center text-destructive">
					<p className="text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (prs.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="text-center text-muted-foreground">
					<GitPullRequest className="h-8 w-8 mx-auto mb-2 opacity-50" />
					<p>
						{isFiltered
							? t("prReview.noResultsFound")
							: t("prReview.noOpenPRs")}
					</p>
				</div>
			</div>
		);
	}

	return (
		<ScrollArea className="flex-1">
			<div className="divide-y divide-border">
				{prs.map((pr) => {
					const status = getPRReviewStatus(getReviewStateForPR(pr.number));

					return (
						<button
							type="button"
							key={pr.number}
							onClick={() => onSelectPR(pr.number)}
							className={cn(
								"w-full p-4 text-left transition-colors hover:bg-accent/50",
								selectedPRNumber === pr.number && "bg-accent",
							)}
						>
							<div className="flex items-start gap-3">
								<GitPullRequest className="h-5 w-5 mt-0.5 text-success shrink-0" />
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 mb-1 flex-wrap">
										<span className="text-sm text-muted-foreground">
											#{pr.number}
										</span>
										<Badge variant="outline" className="text-xs">
											{pr.headRefName}
										</Badge>
										{/* Review status flow dots + label */}
										<PRStatusFlow status={status} />
									</div>
									<h3 className="font-medium text-sm truncate">{pr.title}</h3>
									<div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
										<span className="flex items-center gap-1">
											<User className="h-3 w-3" />
											{pr.author.login}
										</span>
										<span className="flex items-center gap-1">
											<Clock className="h-3 w-3" />
											{formatUpdated(pr.updatedAt, t)}
										</span>
										<span className="flex items-center gap-1">
											<FileDiff className="h-3 w-3" />
											<span className="text-success">+{pr.additions}</span>
											<span className="text-destructive">-{pr.deletions}</span>
										</span>
									</div>
								</div>
							</div>
						</button>
					);
				})}

				{/* Status indicator / Load More button */}
				<div className="py-4 flex justify-center">
					{hasMore ? (
						<Button
							variant="outline"
							size="sm"
							onClick={onLoadMore}
							disabled={isLoadingMore}
						>
							{isLoadingMore ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									{t("prReview.loadingMore")}
								</>
							) : (
								t("prReview.loadMore")
							)}
						</Button>
					) : (
						<span className="text-xs text-muted-foreground opacity-50">
							{t("prReview.allPRsLoaded")}
						</span>
					)}
				</div>
			</div>
		</ScrollArea>
	);
}
