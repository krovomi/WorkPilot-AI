import { Clock, Gauge, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PolicyPauseDetail, Task } from "../../../shared/types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export type PolicyPause =
	| { kind: "hours"; hours: string; timezone: string }
	| { kind: "budget"; spent: number; limit: number }
	| { kind: "taskBudget"; spent: number; limit: number }
	| { kind: "invalid"; count: number };

const POLICY_REASONS: readonly string[] = ["policy_hours", "policy_budget", "policy_invalid"];

/** What the policy watch recorded when it paused the task (`agents/policy_watch.py`), or null. */
export function policyPause(task: Task): PolicyPause | null {
	const paused = task.metadata?.paused;
	if (!paused?.enabled || !POLICY_REASONS.includes(paused.reason ?? "")) return null;
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
	if (
		detail?.reason === "policy_budget" &&
		typeof detail.tokensThisTask === "number" &&
		typeof detail.maxTokensPerTask === "number"
	) {
		return { kind: "taskBudget", spent: detail.tokensThisTask, limit: detail.maxTokensPerTask };
	}
	if (detail?.reason === "policy_invalid" && typeof detail.errorCount === "number") {
		return { kind: "invalid", count: Math.max(1, Math.trunc(detail.errorCount)) };
	}
	return null;
}

const CHIPS = {
	hours: "tasks:policyPause.hoursChip",
	budget: "tasks:policyPause.budgetChip",
	taskBudget: "tasks:policyPause.taskBudgetChip",
	invalid: "tasks:policyPause.invalidChip",
} as const;

const ICONS = { hours: Clock, budget: Gauge, taskBudget: Gauge, invalid: ShieldAlert } as const;

/**
 * Why a task is paused when `workpilot.policy.yaml` stopped it: outside its
 * allowed hours, past its hourly or per-task token budget, or the policy
 * itself invalid. Resuming is the Resume button beside it.
 */
export function TaskPolicyPause({ task }: { readonly task: Task }) {
	const { t, i18n } = useTranslation(["tasks"]);
	const pause = policyPause(task);
	if (!pause) return null;
	const Icon = ICONS[pause.kind];
	let body: string;
	if (pause.kind === "hours") {
		body = t("tasks:policyPause.hoursBody", { hours: pause.hours, timezone: pause.timezone });
	} else if (pause.kind === "invalid") {
		body = t("tasks:policyPause.invalidBody", { count: pause.count });
	} else {
		body = t(pause.kind === "budget" ? "tasks:policyPause.budgetBody" : "tasks:policyPause.taskBudgetBody", {
			spent: pause.spent.toLocaleString(i18n.language),
			limit: pause.limit.toLocaleString(i18n.language),
		});
	}
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="warning" size="sm" className="gap-1.5" data-testid="task-policy-pause">
					<Icon className="h-4 w-4" />
					{t(CHIPS[pause.kind])}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 space-y-3 text-sm">
				<p>{body}</p>
				<p className="text-xs text-muted-foreground">{t("tasks:policyPause.hint")}</p>
			</PopoverContent>
		</Popover>
	);
}
