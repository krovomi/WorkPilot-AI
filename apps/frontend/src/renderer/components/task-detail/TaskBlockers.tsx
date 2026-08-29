import { Lock, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	TASK_STATUS_COLORS,
	TASK_STATUS_LABELS,
} from "../../../shared/constants/task";
import type { Task } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import {
	eligibleBlockers,
	indexTasksById,
	resolveBlockers,
} from "../../lib/kanban-dependencies";
import { cn } from "../../lib/utils";
import { persistUpdateTask, useTaskStore } from "../../stores/task-store";
import { Badge } from "../ui/badge";
import { Combobox } from "../ui/combobox";

interface TaskBlockersProps {
	task: Task;
}

/**
 * "Blocked by" editor: the typed side of task dependencies.
 *
 * `metadata.dependencies` stays what it always was — free text written by
 * ideation and roadmap conversion. This section edits `metadata.blockedBy`,
 * which holds real task ids and is what the queue gate reads.
 *
 * The picker only offers tasks that cannot close a loop, so a cycle never
 * reaches the stored data in the first place.
 */
export function TaskBlockers({ task }: TaskBlockersProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const { toast } = useToast();
	const tasks = useTaskStore((s) => s.tasks);
	const jumpToTask = useTaskStore((s) => s.jumpToTask);
	const [saving, setSaving] = useState(false);

	const byId = useMemo(() => indexTasksById(tasks), [tasks]);
	const state = useMemo(() => resolveBlockers(task, byId), [task, byId]);
	const options = useMemo(
		() =>
			eligibleBlockers(task, tasks).map((candidate) => ({
				value: candidate.id,
				label: candidate.title,
				description: t(
					`tasks:${TASK_STATUS_LABELS[candidate.status] ?? "columns.backlog"}`,
				),
			})),
		[task, tasks, t],
	);

	const declared = task.metadata?.blockedBy ?? [];

	async function write(next: string[]) {
		setSaving(true);
		const ok = await persistUpdateTask(task.id, {
			metadata: { blockedBy: next },
		});
		setSaving(false);
		if (!ok) {
			toast({
				title: t("tasks:metadata.blockedBy.saveErrorTitle"),
				description: t("tasks:metadata.blockedBy.saveErrorDesc"),
				variant: "destructive",
			});
		}
	}

	const add = (id: string) => {
		if (!id || declared.includes(id)) return;
		void write([...declared, id]);
	};

	const remove = (id: string) => {
		void write(declared.filter((existing) => existing !== id));
	};

	const chips = [
		...state.pending.map((b) => ({ task: b, resolved: false })),
		...state.resolved.map((b) => ({ task: b, resolved: true })),
	];

	return (
		<div>
			<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
				<Lock className="h-3 w-3 text-amber-400" />
				{t("tasks:metadata.blockedBy.title")}
			</h3>

			{chips.length === 0 && state.missing.length === 0 && (
				<p className="text-sm text-muted-foreground mb-2">
					{t("tasks:metadata.blockedBy.empty")}
				</p>
			)}

			<div className="flex flex-wrap gap-1.5 mb-2">
				{chips.map(({ task: blocker, resolved }) => (
					<Badge
						key={blocker.id}
						variant="outline"
						className={cn(
							"text-xs pl-1.5 pr-1 py-0.5 flex items-center gap-1.5",
							resolved && "opacity-60",
						)}
					>
						<button
							type="button"
							onClick={() => jumpToTask(blocker.id)}
							className={cn(
								"flex items-center gap-1.5 rounded px-1 hover:underline",
								TASK_STATUS_COLORS[
									blocker.status as keyof typeof TASK_STATUS_COLORS
								] ?? "text-muted-foreground",
							)}
							title={t("tasks:metadata.blockedBy.goToTask")}
						>
							{/* Inherits the status text colour set on the button. */}
							<span className="h-1.5 w-1.5 rounded-full shrink-0 bg-current" />
							<span className={cn(resolved && "line-through")}>
								{blocker.title}
							</span>
						</button>
						<button
							type="button"
							onClick={() => remove(blocker.id)}
							disabled={saving}
							aria-label={t("tasks:metadata.blockedBy.remove", {
								title: blocker.title,
							})}
							className="text-muted-foreground hover:text-destructive disabled:opacity-50"
						>
							<X className="h-3 w-3" />
						</button>
					</Badge>
				))}

				{state.missing.map((id) => (
					<Badge
						key={id}
						variant="outline"
						className="text-xs pl-1.5 pr-1 py-0.5 flex items-center gap-1.5 bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400"
					>
						<span title={t("tasks:metadata.blockedBy.missingHint")}>
							{t("tasks:metadata.blockedBy.missingChip", { id })}
						</span>
						<button
							type="button"
							onClick={() => remove(id)}
							disabled={saving}
							aria-label={t("tasks:metadata.blockedBy.remove", { title: id })}
							className="hover:text-destructive disabled:opacity-50"
						>
							<X className="h-3 w-3" />
						</button>
					</Badge>
				))}
			</div>

			<div className="flex items-center gap-1.5">
				<Plus className="h-3 w-3 text-muted-foreground shrink-0" />
				<Combobox
					value=""
					onValueChange={add}
					options={options}
					disabled={saving || options.length === 0}
					placeholder={t("tasks:metadata.blockedBy.add")}
					searchPlaceholder={t("tasks:metadata.blockedBy.search")}
					emptyMessage={t("tasks:metadata.blockedBy.noCandidate")}
					className="h-7 text-xs max-w-xs"
				/>
			</div>
		</div>
	);
}
