/**
 * The health of a running Mission Control session (#344): what it spent
 * against the budget its crew was composed under, how many times an agent
 * was rebalanced, and the switch that turns automatic rebalancing off.
 */

import { AlertTriangle, Shuffle } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { MissionControlSession } from "../../../shared/types/mission-control";
import { appDateLocale } from "../../lib/date-format";
import { useMissionControlStore } from "../../stores/mission-control-store";
import { Chip, Notice } from "../charter";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";

interface SessionHealthProps {
	readonly session: MissionControlSession;
	/** What the agents spent, as the dashboard sums it. */
	readonly tokens: number;
	readonly cost: number;
}

export function SessionHealth({ session, tokens, cost }: SessionHealthProps) {
	const { t } = useTranslation("missionControl");
	const id = useId();
	const setPlan = useMissionControlStore((s) => s.setPlan);
	const plan = session.plan;
	const count = (value: number) => value.toLocaleString(appDateLocale());

	return (
		<div className="space-y-2" data-testid="mission-control-session-health">
			<div className="flex flex-wrap items-center gap-2">
				{plan?.budget_usd != null && (
					<Chip tone={session.over_budget ? "red" : "green"} dot={false}>
						{t("health.budgetUsd", { spent: cost.toFixed(4), budget: plan.budget_usd.toFixed(4) })}
					</Chip>
				)}
				{plan?.budget_tokens != null && (
					<Chip tone={session.over_budget ? "red" : "green"} dot={false}>
						{t("health.budgetTokens", { spent: count(tokens), budget: count(plan.budget_tokens) })}
					</Chip>
				)}
				<Chip tone="orange" dot={false}>
					<Shuffle className="h-3 w-3" aria-hidden="true" />
					{t("health.rebalances", { count: session.rebalance_count ?? 0 })}
				</Chip>
				<div className="ml-auto flex items-center gap-2">
					<Checkbox
						id={`${id}-auto`}
						checked={plan?.auto_rebalance ?? true}
						onCheckedChange={(checked) => void setPlan({ autoRebalance: checked === true })}
					/>
					<Label htmlFor={`${id}-auto`} className="text-xs">
						{t("health.autoRebalance")}
					</Label>
				</div>
			</div>
			{session.over_budget && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{t("health.overBudget")}
				</Notice>
			)}
		</div>
	);
}
