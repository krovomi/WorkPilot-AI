import { ExternalLink, GitMerge, GitPullRequest, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDate } from "@/lib/date-format";
import type { GitLabMergeRequest } from "../../../../shared/types";
import { cn } from "../../../lib/utils";

interface MergeRequestItemProps {
	mr: GitLabMergeRequest;
	isSelected: boolean;
	onClick: () => void;
}

const STATE_LOOK: Record<
	GitLabMergeRequest["state"],
	{ Icon: typeof GitPullRequest; color: string }
> = {
	opened: { Icon: GitPullRequest, color: "text-success" },
	closed: { Icon: GitPullRequest, color: "text-destructive" },
	merged: { Icon: GitMerge, color: "text-info" },
	locked: { Icon: Lock, color: "text-warning" },
};

export function MergeRequestItem({
	mr,
	isSelected,
	onClick,
}: MergeRequestItemProps) {
	const { t } = useTranslation();
	const { Icon: StateIcon, color } = STATE_LOOK[mr.state];

	// The row and the GitLab link sit side by side: a link inside the row's
	// button was a control inside a control, which a screen reader skips.
	return (
		<div
			className={cn(
				"flex items-start gap-2 rounded-lg border transition-colors",
				isSelected
					? "border-primary bg-primary/5"
					: "border-transparent hover:bg-muted/50",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				aria-pressed={isSelected}
				className="flex-1 min-w-0 text-left p-3 flex items-start gap-3"
			>
				<StateIcon className={cn("h-5 w-5 mt-0.5 shrink-0", color)} />
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground">!{mr.iid}</span>
						<h4 className="text-sm font-medium text-foreground truncate">
							{mr.title}
						</h4>
					</div>
					<div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
						<span>{mr.sourceBranch}</span>
						<span>→</span>
						<span>{mr.targetBranch}</span>
					</div>
					<div className="flex items-center gap-2 mt-1">
						{mr.labels.slice(0, 3).map((label) => (
							<span
								key={label}
								className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
							>
								{label}
							</span>
						))}
						{mr.labels.length > 3 && (
							<span className="text-xs text-muted-foreground">
								+{mr.labels.length - 3}
							</span>
						)}
					</div>
					<div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
						<span>
							{t("gitlab:mergeRequests.byAuthor", {
								author: mr.author.username,
							})}
						</span>
						<span>•</span>
						<span>
							{formatAppDate(mr.createdAt, { month: "short", day: "numeric" })}
						</span>
					</div>
				</div>
			</button>
			<a
				href={mr.webUrl}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={t("common:accessibility.openOnGitLabAriaLabel")}
				className="p-3 text-muted-foreground hover:text-foreground"
			>
				<ExternalLink className="h-4 w-4" />
			</a>
		</div>
	);
}
