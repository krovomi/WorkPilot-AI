/**
 * The team's security reviews of a catalog server (issue #369, lot 5), in a
 * server project only: what the members saw using it, next to the score the
 * app computes. One review per member, which a second write replaces; its
 * author or the project owner deletes it. The server checks every right and
 * the main every argument; this view only hides what the caller cannot do.
 * A comment is shown as text.
 */

import { Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	MCP_REVIEW_MAX_COMMENT,
	MCP_REVIEW_VERDICTS,
	type McpReviewVerdict,
	type McpServerReview,
} from "../../../shared/types/mcp-reviews";
import { formatAppDateTime } from "../../lib/date-format";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { Textarea } from "../ui/textarea";

const VERDICT_TONE: Record<McpReviewVerdict, string> = {
	safe: "text-success",
	caution: "text-warning",
	unsafe: "text-destructive",
};

/** The failures the view names; any other reads as a generic failure. */
const KNOWN_ERRORS = new Set(["too_many_reviews", "review_not_found"]);

interface McpServerReviewsProps {
	readonly serverId: string;
}

export function McpServerReviews({ serverId }: McpServerReviewsProps) {
	const project = useProjectStore((s) =>
		s.projects.find((p) => p.id === s.selectedProjectId),
	);
	if (!project?.remote) return null;
	return (
		<ReviewsPanel
			projectId={project.id}
			serverId={serverId}
			canWrite={project.remote.role !== "viewer"}
		/>
	);
}

interface ReviewsPanelProps {
	readonly projectId: string;
	readonly serverId: string;
	readonly canWrite: boolean;
}

function ReviewsPanel({ projectId, serverId, canWrite }: ReviewsPanelProps) {
	const { t } = useTranslation(["common"]);
	const [reviews, setReviews] = useState<McpServerReview[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [verdict, setVerdict] = useState<McpReviewVerdict>("caution");
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);

	const fill = useCallback((rows: McpServerReview[]) => {
		setReviews(rows);
		const mine = rows.find((review) => review.mine);
		if (mine) {
			setVerdict(mine.verdict);
			setComment(mine.comment);
		}
	}, []);

	useEffect(() => {
		let live = true;
		setReviews(null);
		window.electronAPI
			.listMcpReviews({ projectId, serverId })
			.then((answer) => {
				if (!live) return;
				if (answer.success && answer.data) fill(answer.data);
				else {
					setReviews([]);
					setError(answer.error ?? "failed");
				}
			})
			.catch(() => {
				if (live) {
					setReviews([]);
					setError("failed");
				}
			});
		return () => {
			live = false;
		};
	}, [projectId, serverId, fill]);

	const act = async (call: () => Promise<{ success: boolean; error?: string }>) => {
		setBusy(true);
		setError(null);
		try {
			const answer = await call();
			if (!answer.success) {
				setError(answer.error ?? "failed");
				return;
			}
			const again = await window.electronAPI.listMcpReviews({ projectId, serverId });
			if (again.success && again.data) fill(again.data);
		} catch {
			setError("failed");
		} finally {
			setBusy(false);
		}
	};

	const save = () =>
		act(() => window.electronAPI.putMcpReview({ projectId, serverId, verdict, comment }));
	const remove = (review: McpServerReview) =>
		act(async () => {
			const answer = await window.electronAPI.deleteMcpReview({
				projectId,
				reviewId: review.id,
			});
			if (answer.success && review.mine) {
				setVerdict("caution");
				setComment("");
			}
			return answer;
		});

	const mine = reviews?.find((review) => review.mine);
	const commentId = `mcp-review-comment-${serverId}`;
	const verdictId = `mcp-review-verdict-${serverId}`;

	return (
		<section className="space-y-2" data-testid="mcp-server-reviews">
			<p className="font-medium text-foreground">{t("mcpMarketplace.reviews.title")}</p>
			<p>{t("mcpMarketplace.reviews.hint")}</p>
			{reviews === null ? (
				<Loader2 className="h-3.5 w-3.5 animate-spin" aria-label={t("mcpMarketplace.reviews.loading")} />
			) : reviews.length === 0 ? (
				<p>{t("mcpMarketplace.reviews.none")}</p>
			) : (
				<ul className="space-y-1.5">
					{reviews.map((review) => (
						<li key={review.id} className="rounded border border-border p-2">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className={cn("font-medium", VERDICT_TONE[review.verdict])}>
									{t(`mcpMarketplace.reviews.verdicts.${review.verdict}`)}
								</span>
								<span>
									{t("mcpMarketplace.reviews.by", {
										author: review.author || t("mcpMarketplace.reviews.unknownAuthor"),
									})}
								</span>
								{review.updatedAt && <span>{formatAppDateTime(review.updatedAt)}</span>}
								{review.canDelete && (
									<Button
										variant="ghost"
										size="icon"
										className="ml-auto h-6 w-6 text-destructive hover:text-destructive"
										disabled={busy}
										onClick={() => remove(review)}
										aria-label={t("mcpMarketplace.reviews.delete")}
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								)}
							</div>
							{review.comment && (
								<p className="mt-1 whitespace-pre-line break-words text-foreground">
									{review.comment}
								</p>
							)}
						</li>
					))}
				</ul>
			)}
			{canWrite && reviews !== null && (
				<div className="space-y-1.5">
					<Label htmlFor={verdictId} className="text-xs">
						{mine ? t("mcpMarketplace.reviews.yours") : t("mcpMarketplace.reviews.write")}
					</Label>
					<NativeSelect
						id={verdictId}
						value={verdict}
						onChange={(event) => setVerdict(event.target.value as McpReviewVerdict)}
						className="h-8 w-full text-xs"
					>
						{MCP_REVIEW_VERDICTS.map((value) => (
							<option key={value} value={value}>
								{t(`mcpMarketplace.reviews.verdicts.${value}`)}
							</option>
						))}
					</NativeSelect>
					<Textarea
						id={commentId}
						aria-label={t("mcpMarketplace.reviews.comment")}
						placeholder={t("mcpMarketplace.reviews.commentPlaceholder")}
						value={comment}
						maxLength={MCP_REVIEW_MAX_COMMENT}
						onChange={(event) => setComment(event.target.value)}
						className="min-h-16 text-xs"
					/>
					<Button className="h-7 text-xs" disabled={busy} onClick={save}>
						{mine ? t("mcpMarketplace.reviews.update") : t("mcpMarketplace.reviews.save")}
					</Button>
				</div>
			)}
			{error && (
				<p className="text-destructive" role="alert">
					{KNOWN_ERRORS.has(error)
						? t(`mcpMarketplace.reviews.errors.${error}`)
						: t("mcpMarketplace.reviews.errors.failed")}
				</p>
			)}
		</section>
	);
}
