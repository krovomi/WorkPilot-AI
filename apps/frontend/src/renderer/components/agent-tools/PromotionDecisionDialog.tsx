import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	type PromotionDecision,
	fetchPromotionDecision,
} from "../../lib/agent-tools-api";
import { useTranslation } from "react-i18next";

export interface PromotionDecisionDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly specDir: string;
	/**
	 * Called when the user confirms auto-promotion (skip ai_review →
	 * human_review). The hosting Kanban performs the actual card move.
	 * Receives the decision payload for logging.
	 */
	readonly onAcceptPromotion?: (decision: PromotionDecision) => void;
}

export function PromotionDecisionDialog({
	open,
	onOpenChange,
	specDir,
	onAcceptPromotion,
}: PromotionDecisionDialogProps) {
	const { t } = useTranslation();
	const [decision, setDecision] = useState<PromotionDecision | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setDecision(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchPromotionDecision(specDir, controller.signal)
			.then((res) => {
				if (res.ok) setDecision(res.data.decision);
				else if (res.error !== "aborted") setError(res.error);
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, specDir]);

	const renderBreakdown = (breakdown: Record<string, number>) => {
		const entries = Object.entries(breakdown);
		if (entries.length === 0) return null;
		return (
			<div className="space-y-1">
				{entries.map(([key, delta]) => (
					<div
						key={key}
						className="flex items-center justify-between text-xs font-mono"
					>
						<span className="text-muted-foreground">{key}</span>
						<span
							className={
								delta >= 0
									? "text-emerald-700 dark:text-emerald-300"
									: "text-red-700 dark:text-red-300"
							}
						>
							{delta >= 0 ? "+" : ""}
							{delta}
						</span>
					</div>
				))}
			</div>
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("agentTools:promotion.title")}</DialogTitle>
					<DialogDescription>
						{t("agentTools:promotion.descriptionBefore")}{" "}
						<code className="text-xs">human_review</code>{t("agentTools:promotion.descriptionMiddle")} <code className="text-xs">WORKPILOT_AUTO_PROMOTE_THRESHOLD</code>{" "}
						{t("agentTools:promotion.descriptionAfter")}
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-6 text-center text-sm text-muted-foreground">
						{t("agentTools:promotion.scoring")}
					</div>
				)}

				{error && (
					<div className="rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						{error}
					</div>
				)}

				{decision && (
					<div className="space-y-4">
						<div className="flex items-center justify-between rounded-md border p-3">
							<div>
								<div className="text-xs text-muted-foreground">
									{t("agentTools:promotion.confidence")}
								</div>
								<div className="text-2xl font-semibold">
									{decision.score}
									<span className="text-muted-foreground text-base">/100</span>
								</div>
							</div>
							{decision.threshold === null ? (
								<Badge className="bg-slate-500/15 text-slate-700 dark:text-slate-300">
									{t("agentTools:promotion.featureOff")}
								</Badge>
							) : decision.promote ? (
								<Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
									{t("agentTools:promotion.ready", { threshold: decision.threshold })}
								</Badge>
							) : (
								<Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
									{t("agentTools:promotion.below", { threshold: decision.threshold })}
								</Badge>
							)}
						</div>

						{renderBreakdown(decision.breakdown)}

						{decision.reasons.length > 0 && (
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground">
									{t("agentTools:promotion.reasoning", {
										count: decision.reasons.length,
									})}
								</summary>
								<ul className="mt-2 space-y-0.5">
									{decision.reasons.map((r) => (
										<li key={r} className="text-muted-foreground">
											· {r}
										</li>
									))}
								</ul>
							</details>
						)}
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("common:buttons.close")}
					</Button>
					<Button
						disabled={!decision?.promote}
						onClick={() => {
							if (decision) onAcceptPromotion?.(decision);
							onOpenChange(false);
						}}
					>
						{t("agentTools:promotion.accept")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
