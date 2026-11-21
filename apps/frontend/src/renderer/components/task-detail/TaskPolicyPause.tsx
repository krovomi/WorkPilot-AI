import { Clock, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PolicyPauseDetail, Task } from "../../../shared/types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export type PolicyPause =
	| { kind: "hours"; hours: string; timezone: string }
	| { kind: "budget"; spent: number; limit: number };

/** What the policy watch recorded when it paused the task (`agents/policy_watch.py`), or null. */
export function policyPause(task: Task): PolicyPause | null {
	const paused = task.metadata?.paused;
	if (!paused?.enabled || (paused.reason !== "policy_hours" && paused.reason !== "policy_budget")) return null;
	const detail: PolicyPauseDetail | undefined = paused.policy;
	if (detail?.reason === "policy_hours" && Array.isArray(detail.allowedHours)) {
		return { kind: "hours", hours: detail.allowedHours.join(", "), timezone: detail.timezone ?? "" };
	}
	if (
		detail?.reason === "policy_budget" &&
		typeof detail.tokensLastHour === "number" &&
		typeof detail.maxTokensPerHour === "number"
	) {
		return { kind: "budget", spent: detail.tokensLastHour, limit: detail.maxTokensPerHour };
	}
	return null;
}

/**
 * Why a task is paused when `workpilot.policy.yaml` stopped it: outside its
 * allowed hours, or past its hourly token budget. Resuming is the Resume
 * button beside it.
 */
export function TaskPolicyPause({ task }: { readonly task: Task }) {
	const { t, i18n } = useTranslation(["tasks"]);
	const pause = policyPause(task);
	if (!pause) return null;
	const hours = pause.kind === "hours";
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="warning" size="sm" className="gap-1.5" data-testid="task-policy-pause">
					{hours ? <Clock className="h-4 w-4" /> : <Gauge className="h-4 w-4" />}
					{t(hours ? "tasks:policyPause.hoursChip" : "tasks:policyPause.budgetChip")}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 space-y-3 text-sm">
				<p>
					{pause.kind === "hours"
						? t("tasks:policyPause.hoursBody", { hours: pause.hours, timezone: pause.timezone })
						: t("tasks:policyPause.budgetBody", {
								spent: pause.spent.toLocaleString(i18n.language),
								limit: pause.limit.toLocaleString(i18n.language),
							})}
				</p>
				<p className="text-xs text-muted-foreground">{t("tasks:policyPause.hint")}</p>
			</PopoverContent>
		</Popover>
	);
}
