import {
	AlertTriangle,
	FileWarning,
	Loader2,
	Lock,
	ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TASK_STATUS_LABELS } from "../../../shared/constants/task";
import type {
	IPCResult,
	PlanConflictReport,
	Task,
} from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import {
	indexTasksById,
	wouldCreateCycle,
} from "../../lib/kanban-dependencies";
import { persistUpdateTask, useTaskStore } from "../../stores/task-store";

interface PlanConflictAlertProps {
	readonly task: Task;
}

const MAX_FILES_SHOWN = 6;

/**
 * PlanConflictAlert - Warns at plan review time when another active task's
 * plan touches the same files as this one. Two parallel worktrees modifying
 * the same file will almost certainly produce a merge conflict at the end;
 * raising it here lets the user sequence the tasks or re-scope the plan.
 */
export function PlanConflictAlert({ task }: PlanConflictAlertProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const [report, setReport] = useState<PlanConflictReport | null>(null);
	const [isChecking, setIsChecking] = useState(true);
	const [savingId, setSavingId] = useState<string | null>(null);
	const tasks = useTaskStore((s) => s.tasks);
	const byId = useMemo(() => indexTasksById(tasks), [tasks]);
	const blockedBy = task.metadata?.blockedBy ?? [];

	/**
	 * Turn the warning into an ordering decision: declaring the rival task as a
	 * prerequisite is exactly what stops the two worktrees from running at once.
	 */
	async function dependOn(blockerId: string, blockerTitle: string) {
		setSavingId(blockerId);
		const ok = await persistUpdateTask(task.id, {
			metadata: { blockedBy: [...blockedBy, blockerId] },
		});
		setSavingId(null);
		toast(
			ok
				? {
						title: t("tasks:modal.plan.conflictsDependencyAdded", {
							title: blockerTitle,
						}),
					}
				: {
						title: t("tasks:metadata.blockedBy.saveErrorTitle"),
						description: t("tasks:metadata.blockedBy.saveErrorDesc"),
						variant: "destructive",
					},
		);
	}

	useEffect(() => {
		let cancelled = false;
		setIsChecking(true);
		globalThis.electronAPI
			.checkPlanConflicts(task.id)
			.then((result: IPCResult<PlanConflictReport>) => {
				if (!cancelled && result.success && result.data) {
					setReport(result.data);
				}
			})
			.catch((err: unknown) => {
				console.error("Plan conflict check failed:", err);
			})
			.finally(() => {
				if (!cancelled) setIsChecking(false);
			});
		return () => {
			cancelled = true;
		};
	}, [task.id]);

	if (isChecking) {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Loader2 className="h-3.5 w-3.5 animate-spin" />
				{t("tasks:modal.plan.conflictsChecking")}
			</div>
		);
	}

	if (!report) {
		return null;
	}

	if (report.conflictingTasks.length === 0) {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<ShieldCheck className="h-3.5 w-3.5 text-success" />
				{t("tasks:modal.plan.conflictsNone")}
			</div>
		);
	}

	return (
		<div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-3">
			<div className="flex items-center gap-2">
				<AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
				<span className="font-semibold text-sm text-foreground">
					{t("tasks:modal.plan.conflictsTitle")}
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				{t("tasks:modal.plan.conflictsDescription", {
					count: report.totalConflictingFiles,
				})}
			</p>
			<div className="space-y-2">
				{report.conflictingTasks.map((conflict) => (
					<div
						key={conflict.taskId}
						className="rounded-md border border-border bg-background/60 p-2"
					>
						<div className="flex items-center justify-between gap-2 mb-1.5">
							<span className="text-xs font-medium text-foreground truncate">
								{conflict.taskTitle}
							</span>
							<span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
								{t(`tasks:${TASK_STATUS_LABELS[conflict.taskStatus]}`, {
									defaultValue: conflict.taskStatus,
								})}
							</span>
						</div>
						<ul className="space-y-0.5">
							{conflict.files.slice(0, MAX_FILES_SHOWN).map((file) => (
								<li
									key={file}
									className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground"
								>
									<FileWarning className="h-3 w-3 text-warning shrink-0" />
									<span className="truncate" title={file}>
										{file}
									</span>
								</li>
							))}
						</ul>
						{conflict.files.length > MAX_FILES_SHOWN && (
							<span className="text-[10px] text-muted-foreground">
								{t("tasks:modal.plan.conflictsMoreFiles", {
									count: conflict.files.length - MAX_FILES_SHOWN,
								})}
							</span>
						)}
						{(() => {
							const already = blockedBy.includes(conflict.taskId);
							const cycles = wouldCreateCycle(
								task.id,
								conflict.taskId,
								byId,
							);
							if (already || cycles) {
								return (
									<p className="mt-1.5 text-[10px] text-muted-foreground">
										{already
											? t("tasks:modal.plan.conflictsDependencyExists")
											: t("tasks:modal.plan.conflictsDependencyCycle")}
									</p>
								);
							}
							return (
								<button
									type="button"
									onClick={() =>
										void dependOn(conflict.taskId, conflict.taskTitle)
									}
									disabled={savingId !== null}
									className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-foreground/80 hover:text-foreground underline underline-offset-2 disabled:opacity-50"
								>
									<Lock className="h-2.5 w-2.5" />
									{t("tasks:modal.plan.conflictsMakeDependency")}
								</button>
							);
						})()}
					</div>
				))}
			</div>
		</div>
	);
}
