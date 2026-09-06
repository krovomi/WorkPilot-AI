import type { Task } from "@shared/types/task";
import { ChevronUp, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface BackgroundTasksIndicatorProps {
	/** Tasks still running while the user is somewhere other than the Kanban. */
	tasks: Task[];
	/** Jump back to the Kanban, optionally opening one task. */
	onOpenTask: (taskId?: string) => void;
}

/**
 * Floating reminder that agents are still working after the user left the
 * Kanban. Without it "continue in the background" is indistinguishable from
 * "stop": the work keeps running and nothing on screen says so.
 */
export function BackgroundTasksIndicator({
	tasks,
	onOpenTask,
}: BackgroundTasksIndicatorProps) {
	const { t } = useTranslation("common");
	const [expanded, setExpanded] = useState(false);
	// Dismissal is per set of running tasks: a task starting later brings the
	// pill back rather than staying hidden for the rest of the session.
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);

	const key = tasks
		.map((task) => task.id)
		.sort()
		.join("|");

	if (tasks.length === 0 || key === dismissedKey) return null;

	return (
		<div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
			{expanded && (
				<ul className="w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
					{tasks.map((task) => (
						<li key={task.id}>
							<button
								type="button"
								onClick={() => onOpenTask(task.id)}
								className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent"
							>
								<Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
								<span className="truncate text-foreground">{task.title}</span>
							</button>
						</li>
					))}
				</ul>
			)}

			<div className="flex items-center gap-1 rounded-full border border-border bg-popover py-1 pl-3 pr-1 shadow-lg">
				<button
					type="button"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					className="flex items-center gap-2 text-xs font-medium text-foreground"
				>
					<Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
					{t("backgroundTasks.running", { count: tasks.length })}
					<ChevronUp
						className={cn(
							"h-3.5 w-3.5 text-muted-foreground transition-transform",
							expanded && "rotate-180",
						)}
					/>
				</button>

				<button
					type="button"
					onClick={() => onOpenTask()}
					className="rounded-full px-2 py-1 text-xs font-medium text-primary hover:bg-accent"
				>
					{t("backgroundTasks.openKanban")}
				</button>

				<button
					type="button"
					onClick={() => setDismissedKey(key)}
					aria-label={t("backgroundTasks.dismiss")}
					className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
