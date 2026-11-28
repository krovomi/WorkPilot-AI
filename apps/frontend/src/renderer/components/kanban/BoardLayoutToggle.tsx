/**
 * The toolbar's choice between the board's columns, the list of its cards
 * (`BoardList`) and their timeline (`BoardTimeline`). A per-viewer preference, kept with the lanes'
 * (`stores/kanban-lanes-store.ts`), and brought back by a saved view.
 */
import { ChartGantt, Columns3, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BOARD_LAYOUTS, type BoardLayout } from "../../lib/kanban-list";
import { cn } from "../../lib/utils";
import { useKanbanLanesStore } from "../../stores/kanban-lanes-store";

const ICONS: Record<BoardLayout, typeof List> = { board: Columns3, list: List, timeline: ChartGantt };

export function BoardLayoutToggle() {
	const { t } = useTranslation(["tasks"]);
	const layout = useKanbanLanesStore((s) => s.layout);
	const setLayout = useKanbanLanesStore((s) => s.setLayout);
	return (
		<fieldset className="flex items-center rounded-full bg-muted/40 p-0.5">
			<legend className="sr-only">{t("tasks:kanban.layout.label")}</legend>
			{BOARD_LAYOUTS.map((item) => {
				const Icon = ICONS[item];
				const label = t(`tasks:kanban.layout.${item}`);
				return (
					<button
						key={item}
						type="button"
						aria-pressed={layout === item}
						onClick={() => setLayout(item)}
						title={label}
						aria-label={label}
						className={cn(
							"flex h-7 w-7 items-center justify-center rounded-full transition-colors",
							layout === item
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="h-4 w-4" aria-hidden="true" />
					</button>
				);
			})}
		</fieldset>
	);
}
