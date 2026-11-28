/**
 * A card's labels, as small chips under its title. A chip filters the board
 * by its label (a control: kept out of the card's click).
 */
import type { Task } from "../../../../shared/types";
import { taskLabels } from "../../../../shared/utils/task-labels";
import { useKanbanFilterStore } from "../../../stores/kanban-filter-store";
import { useTranslation } from "react-i18next";

export function CardLabels({ task }: { readonly task: Pick<Task, "metadata"> }) {
	const { t } = useTranslation(["tasks"]);
	const toggleLabel = useKanbanFilterStore((s) => s.toggleLabel);
	const labels = taskLabels(task);
	if (labels.length === 0) return null;
	return (
		<ul className="relative z-10 mt-1.5 flex flex-wrap gap-1" aria-label={t("tasks:cardLabels.listLabel")}>
			{labels.map((label) => (
				<li key={label}>
					<button
						type="button"
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							toggleLabel(label);
						}}
						title={t("tasks:cardLabels.filterBy", { label })}
						className="max-w-[10rem] truncate rounded border border-border/60 bg-muted/50 px-1.5 text-2xs leading-4 text-muted-foreground hover:border-primary/40 hover:text-primary"
					>
						{label}
					</button>
				</li>
			))}
		</ul>
	);
}
