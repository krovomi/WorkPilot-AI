import type { TFunction } from "i18next";
import type { Task } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { recordUndo } from "../../stores/board-undo-store";
import { DEFERRED_DELETE_MS, deleteLater } from "../../stores/pending-delete-store";

/**
 * Deletes cards nothing has worked on yet (isLightCard) without asking:
 * they disappear now and are deleted after a few seconds, unless "Undo" in
 * the toast, or Ctrl+Z, brings them back first.
 */
export function deleteCardsLater(tasks: readonly Task[], t: TFunction): void {
	const pending = deleteLater(
		tasks.map((task) => task.id),
		(error) =>
			toast({
				title: t("tasks:kanban.deleteError"),
				description: error,
				variant: "destructive",
			}),
	);
	recordUndo({
		label: t("tasks:kanban.undoLabels.delete", { count: tasks.length }),
		undo: async () => pending.cancel(),
	});
	const shown = toast({
		title:
			tasks.length === 1
				? t("tasks:kanban.deleteSuccessSingle", { title: tasks[0].title })
				: t("tasks:kanban.deleteSuccess", { count: tasks.length }),
		duration: DEFERRED_DELETE_MS,
		action: (
			<button
				type="button"
				onClick={() => {
					pending.cancel();
					shown.dismiss();
				}}
				className="px-2 py-1 text-sm bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors"
			>
				{t("tasks:kanban.undo")}
			</button>
		),
	});
}
