/**
 * What lot 4 of #366 adds under a run's watch: the linked services its
 * rollback took back (or that need a person), a person's word on a bad
 * verdict (a false alarm, or a real problem; it feeds the figures), and the
 * way to investigate the incident in Self-Healing or on the task whose PR was
 * deployed.
 */

import { ExternalLink, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type {
	DeployLinkedRollback,
	DeployVerdictReview,
	DeployWatch,
} from "../../../shared/types/deploy-watch";
import { CharterButton } from "../charter";

export function LinkedRollbacks({ linked }: { readonly linked: DeployLinkedRollback[] }): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	return (
		<ul className="space-y-0.5" data-testid="deploy-linked">
			{linked.map((entry) => (
				<li
					key={entry.projectId}
					className={entry.status === "failed" || entry.status === "error" ? "text-destructive" : "wp-meta"}
				>
					{t(`cicdTriggers:watch.linked.${entry.status}`, {
						project: entry.name || entry.projectId,
					})}
					{entry.migrations.length > 0 &&
						` ${t("cicdTriggers:watch.linked.migrations", { files: entry.migrations.join(", ") })}`}
					{entry.targetUrl && (
						<a
							href={entry.targetUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="ml-1 inline-flex items-center gap-1 text-primary hover:underline"
						>
							<ExternalLink className="h-3 w-3" />
							{t("cicdTriggers:watch.linked.openTarget")}
						</a>
					)}
				</li>
			))}
		</ul>
	);
}

const REVIEWS: readonly { review: DeployVerdictReview; icon: typeof ThumbsUp }[] = [
	{ review: "false_positive", icon: ThumbsDown },
	{ review: "confirmed", icon: ThumbsUp },
];

/** A done watch with a bad verdict can be called a false alarm or a real problem. */
export function canReview(watch: DeployWatch): boolean {
	return watch.phase === "done" && (watch.verdict === "warning" || watch.verdict === "critical");
}

export function VerdictReview({
	watch,
	onReview,
}: {
	readonly watch: DeployWatch;
	readonly onReview: (review: DeployVerdictReview | null) => void;
}): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid="deploy-review">
			<span className="wp-meta">{t("cicdTriggers:watch.review.question")}</span>
			{REVIEWS.map(({ review, icon }) => (
				<CharterButton
					key={review}
					size="sm"
					variant={watch.review === review ? "primary" : "ghost"}
					icon={icon}
					aria-pressed={watch.review === review}
					onClick={() => onReview(watch.review === review ? null : review)}
				>
					{t(`cicdTriggers:watch.review.${review}`)}
				</CharterButton>
			))}
		</div>
	);
}

function navigate(detail: { view: string; taskId?: string }): void {
	window.dispatchEvent(new CustomEvent("workpilot:navigate-view", { detail }));
}

/** Self-Healing for the incident; the task whose PR was deployed, when there is one. */
export function InvestigateLinks({ taskId }: { readonly taskId?: string }): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid="deploy-investigate">
			<CharterButton size="sm" variant="ghost" icon={Search} onClick={() => navigate({ view: "self-healing" })}>
				{t("cicdTriggers:watch.investigate.selfHealing")}
			</CharterButton>
			{taskId && (
				<CharterButton size="sm" variant="ghost" onClick={() => navigate({ view: "kanban", taskId })}>
					{t("cicdTriggers:watch.investigate.task")}
				</CharterButton>
			)}
		</div>
	);
}
