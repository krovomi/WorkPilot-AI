/**
 * The « Bloquée » banner of a flagged card: what blocks it, and the button
 * that lifts the flag. Kept out of the card's click (it is a control).
 */
import { Flag, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { unflagTask } from "../../stores/task-flag-actions";

export function FlagBanner({ task }: { readonly task: Pick<Task, "id" | "metadata"> }) {
	const { t } = useTranslation(["tasks"]);
	const reason = task.metadata?.flaggedReason;
	return (
		<div className="relative z-10 mb-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1">
			<Flag className="h-3.5 w-3.5 shrink-0 fill-destructive text-destructive" />
			<span className="min-w-0 truncate text-2xs font-medium text-destructive" title={reason}>
				{reason || t("tasks:flag.badge")}
			</span>
			<button
				type="button"
				className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-muted-foreground hover:bg-muted"
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					void unflagTask(task.id).then((result) => {
						if (!result.success) {
							toast({
								title: t("tasks:flag.failedTitle"),
								description: result.error || t("tasks:flag.failedDescription"),
								variant: "destructive",
							});
						}
					});
				}}
				title={t("tasks:flag.unflag")}
			>
				<X className="h-3 w-3" />
				{t("tasks:flag.unflag")}
			</button>
		</div>
	);
}
