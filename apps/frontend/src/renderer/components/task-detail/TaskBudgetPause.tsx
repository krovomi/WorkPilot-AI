import { Coins, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BudgetPauseDetail, Task } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { resumeTask } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const BUDGET_REASONS = new Set(["budget", "budget_stall"]);

/** The budget block of a task the backend paused for its cost budget, or null. */
export function budgetPause(task: Task): BudgetPauseDetail | null {
	const paused = task.metadata?.paused;
	if (!paused?.enabled || !BUDGET_REASONS.has(paused.reason ?? "")) return null;
	const detail = paused.budget;
	return detail && typeof detail.limitUsd === "number" && typeof detail.spentUsd === "number"
		? detail
		: null;
}

function usd(amount: number, language: string): string {
	return new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(amount);
}

/** A raise worth resuming with: half again the limit, at least 1 USD over the spend. */
export function suggestedLimit(detail: BudgetPauseDetail): number {
	return Math.ceil(Math.max(detail.limitUsd * 1.5, detail.spentUsd + 1));
}

/**
 * Why a task paused on its budget, and what resuming takes: a higher limit for
 * the task (set here, then resumed), the project's budget raised in Costs, or,
 * for a task that spent without progress, a look at the logs and a resume.
 */
export function TaskBudgetPause({ task }: { readonly task: Task }) {
	const { t, i18n } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const detail = budgetPause(task);
	const [amount, setAmount] = useState(() => (detail ? String(suggestedLimit(detail)) : ""));
	const [busy, setBusy] = useState(false);
	if (!detail) return null;

	const spent = usd(detail.spentUsd, i18n.language);
	const limit = usd(detail.limitUsd, i18n.language);
	const floor = detail.complete === false ? t("tasks:budgetPause.floor") : "";

	const raiseAndResume = async () => {
		const value = Number(amount);
		if (!Number.isFinite(value) || value <= detail.spentUsd) {
			toast({ variant: "destructive", title: t("tasks:budgetPause.tooLow", { spent }) });
			return;
		}
		setBusy(true);
		try {
			const saved = await globalThis.electronAPI.setTaskBudget(task.projectId, task.id, value);
			if (!saved.success) {
				toast({ variant: "destructive", title: t("tasks:budgetPause.saveFailed") });
				return;
			}
			const resumed = await resumeTask(task.id);
			toast(
				resumed
					? { title: t("tasks:budgetPause.resumed", { limit: usd(value, i18n.language) }) }
					: { variant: "destructive", title: t("tasks:modal.actions.resumeFailed") },
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="warning" size="sm" className="gap-1.5" data-testid="task-budget-pause">
					<Coins className="h-4 w-4" />
					{detail.scope === "stall"
						? t("tasks:budgetPause.stallChip")
						: t("tasks:budgetPause.chip", { spent, limit })}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 space-y-3 text-sm">
				{detail.scope === "stall" ? (
					<p>
						{t("tasks:budgetPause.stall", {
							spent,
							limit,
							done: detail.completedSubtasks ?? 0,
							total: detail.totalSubtasks ?? 0,
						})}
					</p>
				) : (
					<p>
						{t(`tasks:budgetPause.${detail.scope === "project" ? "project" : "task"}`, {
							spent,
							limit,
							floor,
						})}
					</p>
				)}
				{detail.scope === "task" && (
					<div className="space-y-2">
						<label className="text-xs font-medium" htmlFor={`budget-${task.id}`}>
							{t("tasks:budgetPause.newLimit")}
						</label>
						<div className="flex items-center gap-2">
							<Input
								id={`budget-${task.id}`}
								type="number"
								min={0}
								step="0.5"
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
							/>
							<Button size="sm" onClick={raiseAndResume} disabled={busy}>
								{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
								{t("tasks:budgetPause.raise")}
							</Button>
						</div>
					</div>
				)}
				{detail.scope !== "task" && (
					<p className="text-xs text-muted-foreground">
						{detail.scope === "project"
							? t("tasks:budgetPause.projectHint")
							: t("tasks:budgetPause.stallHint")}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}
