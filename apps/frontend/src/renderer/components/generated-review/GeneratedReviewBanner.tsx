import { ExternalLink, GitBranch, GitPullRequest, KanbanSquare } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GeneratedReview } from "../../../shared/types/generated-review";
import { loadTasks } from "../../stores/task-store";
import { CharterButton, Notice } from "../charter";

interface GeneratedReviewBannerProps {
	readonly review: GeneratedReview;
	/** The project the card belongs to (the board reloads before it opens). */
	readonly projectId: string | undefined;
	readonly className?: string;
	/** Called before the Kanban opens, e.g. to close the dialog the banner sits in. */
	readonly onOpenCard?: () => void;
}

type PrState =
	| { readonly kind: "idle" }
	| { readonly kind: "creating" }
	| { readonly kind: "created"; readonly url?: string; readonly message?: string }
	| { readonly kind: "failed"; readonly message: string };

/**
 * Where a page's generated code went: a Kanban card in human review, on its
 * own branch, and never the project folder. The person opens the card to read
 * the diff, or opens the pull request from here with the card's defaults
 * (main/generated-review/).
 */
export function GeneratedReviewBanner({
	review,
	projectId,
	className,
	onOpenCard,
}: GeneratedReviewBannerProps) {
	const { t } = useTranslation("common");
	const [pr, setPr] = useState<PrState>({ kind: "idle" });

	const openCard = async () => {
		if (projectId) await loadTasks(projectId, { forceRefresh: true });
		onOpenCard?.();
		globalThis.dispatchEvent(
			new CustomEvent("workpilot:navigate-view", {
				detail: { view: "kanban", taskId: review.taskId },
			}),
		);
	};

	const createPr = async () => {
		setPr({ kind: "creating" });
		try {
			const response = await globalThis.electronAPI.createWorktreePR(review.taskId, {
				title: review.title,
			});
			const data = response.data;
			if (!response.success || !data?.success) {
				setPr({
					kind: "failed",
					message: data?.error || data?.message || response.error || t("generatedReview.prFailed"),
				});
				return;
			}
			setPr({ kind: "created", url: data.prUrl, message: data.message });
			if (projectId) void loadTasks(projectId, { forceRefresh: true });
		} catch (error) {
			setPr({
				kind: "failed",
				message: error instanceof Error ? error.message : t("generatedReview.prFailed"),
			});
		}
	};

	return (
		<Notice tone="accent" icon={GitBranch} role="status" className={className}>
			<div data-testid="generated-review-banner">
				<strong>{t("generatedReview.title")}</strong>
				<p className="mt-1 text-xs opacity-90">
					{t("generatedReview.body", {
						count: review.files.length,
						branch: review.branch,
						card: review.title,
						base: review.baseBranch || t("generatedReview.defaultBase"),
					})}
				</p>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<CharterButton size="sm" icon={KanbanSquare} onClick={() => void openCard()}>
						{t("generatedReview.openCard")}
					</CharterButton>
					{pr.kind === "created" ? (
						pr.url ? (
							<CharterButton
								size="sm"
								icon={ExternalLink}
								onClick={() => globalThis.electronAPI.openExternal(pr.url as string)}
							>
								{t("generatedReview.openPr")}
							</CharterButton>
						) : (
							<span className="text-xs">{pr.message || t("generatedReview.prCreated")}</span>
						)
					) : (
						<CharterButton
							size="sm"
							variant="primary"
							icon={GitPullRequest}
							busy={pr.kind === "creating"}
							disabled={pr.kind === "creating"}
							onClick={() => void createPr()}
						>
							{pr.kind === "creating" ? t("generatedReview.creatingPr") : t("generatedReview.createPr")}
						</CharterButton>
					)}
				</div>
				{pr.kind === "failed" && (
					<p className="mt-2 text-xs" role="alert">
						{pr.message}
					</p>
				)}
			</div>
		</Notice>
	);
}
