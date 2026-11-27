import { GitMerge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task, TaskApprovalSummary } from "../../../shared/types";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";

const TIERS = new Set(["N0", "N1", "N2", "N3"]);

const TONE: Record<string, string> = {
	N0: "bg-success/10 text-success border-success/30",
	N1: "bg-info/10 text-info border-info/30",
	N2: "bg-warning/10 text-warning border-warning/30",
	N3: "bg-destructive/10 text-destructive border-destructive/30",
};

/** The tier the approval step gave the task's green PR, when it gave one. */
export function shownApprovalTier(approval: TaskApprovalSummary | undefined): string | null {
	return approval && TIERS.has(approval.tier ?? "") ? (approval.tier as string) : null;
}

/**
 * The approval tier of the task's green pull request
 * (`apps/backend/pr_followup/approval.py`): N0 to N3, then what happened
 * (merged by itself, waiting for a person, observed only). Nothing when no
 * tier was given; an error shows nothing either, the PR simply waits.
 */
export function ApprovalTierBadge({ task }: { readonly task: Task }) {
	const { t } = useTranslation("tasks");
	const approval = task.approval;
	const tier = shownApprovalTier(approval);
	if (!approval || !tier) return null;
	const outcome = approval.merged
		? "merged"
		: approval.mode === "enforce"
			? approval.action === "merge"
				? "mergeFailed"
				: "waiting"
			: "observed";
	const reasons = (approval.reasons ?? [])
		.slice(0, 3)
		.map((r) => t(`approvalTier.reasons.${r.code}`, { defaultValue: r.code }))
		.join(", ");
	return (
		<Badge
			variant="outline"
			data-testid="approval-tier-badge"
			className={cn("text-3xs px-1.5 py-0.5 flex items-center gap-1", TONE[tier])}
			title={t("approvalTier.tooltip", {
				outcome: t(`approvalTier.outcome.${outcome}`),
				reasons,
			})}
		>
			<GitMerge className="h-2.5 w-2.5" />
			{t("approvalTier.cardBadge", { tier, outcome: t(`approvalTier.outcome.${outcome}`) })}
		</Badge>
	);
}
