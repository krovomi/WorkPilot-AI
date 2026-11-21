/**
 * The rejections a server project holds for a maintainer (#361, lot 3): a
 * member's rejection teaches the reviewer only once a project owner approves
 * it. Everyone sees the list; only a maintainer gets the buttons, and the
 * server checks it again.
 */

import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { HeldRejection } from "../../../../shared/types/review-feedback";
import { Button } from "../../ui/button";
import type { ReviewFeedbackStatsState } from "../hooks/useReviewFeedbackStats";

function HeldItem({
	item,
	maintainer,
	state,
}: {
	item: HeldRejection;
	maintainer: boolean;
	state: ReviewFeedbackStatsState;
}) {
	const { t } = useTranslation(["reviewFeedback", "common"]);
	const busy = state.pendingHeld !== null;
	return (
		<li className="flex items-start gap-2 border-t border-border/50 pt-2">
			<div className="flex-1 min-w-0 space-y-1">
				<div className="flex items-center gap-2 flex-wrap">
					<span>{t("reviewFeedback:held.pr", { number: item.prNumber })}</span>
					<code className="bg-muted px-1 rounded">{item.category}</code>
					<span className="font-medium text-foreground break-words">{item.label}</span>
				</div>
				<p className="text-muted-foreground">
					{t(
						item.verdict === "rejected"
							? "common:prReview.feedback.reject"
							: "common:prReview.feedback.notApplicable",
					)}
					{item.reason && (
						<>
							{" · "}
							{t(`common:prReview.feedback.reasons.${item.reason}`)}
						</>
					)}
					{item.note && (
						<>
							{" · "}
							<q className="break-words">{item.note}</q>
						</>
					)}
				</p>
			</div>
			{maintainer && (
				<div className="flex gap-1 shrink-0">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7 px-2 text-xs"
						disabled={busy}
						aria-label={t("reviewFeedback:held.approveLabel", { label: item.label })}
						onClick={() => void state.decide(item.prNumber, item.findingId, true)}
					>
						<Check className="h-3 w-3 mr-1" />
						{t("reviewFeedback:held.approve")}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs"
						disabled={busy}
						aria-label={t("reviewFeedback:held.discardLabel", { label: item.label })}
						onClick={() => void state.decide(item.prNumber, item.findingId, false)}
					>
						<X className="h-3 w-3 mr-1" />
						{t("reviewFeedback:held.discard")}
					</Button>
				</div>
			)}
		</li>
	);
}

export function ReviewFeedbackHeld({ state }: { state: ReviewFeedbackStatsState }) {
	const { t } = useTranslation("reviewFeedback");
	const server = state.stats?.server;
	if (!server || server.held.length === 0) return null;
	return (
		<div className="space-y-2 border-t border-border/50 pt-2">
			<p className="font-medium text-foreground">
				{t("held.title", { count: server.held.length })}
			</p>
			<p>{t("held.hint")}</p>
			<ul className="space-y-2">
				{server.held.map((item) => (
					<HeldItem
						key={`${item.prNumber}:${item.findingId}`}
						item={item}
						maintainer={server.maintainer}
						state={state}
					/>
				))}
			</ul>
		</div>
	);
}
