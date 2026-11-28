/**
 * The board as a list (Jira's list view): one row per card, its status,
 * priority, sprint, sub-project, points and last change. A header sorts the
 * rows (`lib/kanban-list.ts`); with lanes, each lane is a section of its own.
 * A row opens its card, as a card does on the board.
 *
 * Rendered by BoardLanes when the toolbar's layout is « List ».
 * Design: docs/architecture/kanban-list-view.md.
 */
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Flag } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CARD_TYPES, resolveCardType } from "../../../shared/constants/card-types";
import { TASK_STATUS_LABELS, type TaskStatusColumn } from "../../../shared/constants/task";
import type { Task } from "../../../shared/types";
import { orderedSprints, taskPoints } from "../../../shared/utils/sprints";
import { formatAppDate } from "../../lib/date-format";
import { LIST_SORT_FIELDS, type ListRow, type ListSortField, nextListSort, sortRows } from "../../lib/kanban-list";
import { cn } from "../../lib/utils";
import { useKanbanLanesStore } from "../../stores/kanban-lanes-store";
import { useSprintStore } from "../../stores/sprint-store";

/** A section of the list: a lane, or the whole board without lanes. */
export interface ListSection {
	key: string;
	/** Absent without lanes: the rows have no header above them. */
	label?: string;
	marker?: ReactNode;
	rows: ListRow[];
}

interface BoardListProps {
	sections: ListSection[];
	columnOrder: readonly TaskStatusColumn[];
	collapsed: readonly string[];
	onToggleSection: (key: string) => void;
	onOpenTask?: (task: Task) => void;
}

const NONE = "—";

function ListHeader() {
	const { t } = useTranslation(["tasks"]);
	const sort = useKanbanLanesStore((s) => s.listSort);
	const setListSort = useKanbanLanesStore((s) => s.setListSort);
	const sortState = (field: ListSortField) =>
		sort?.field !== field ? "none" : sort.direction === "asc" ? "ascending" : "descending";
	return (
		<thead className="sticky top-0 z-10 bg-background">
			<tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
				{LIST_SORT_FIELDS.map((field) => (
					<th key={field} scope="col" aria-sort={sortState(field)} className="px-3 py-2 font-medium">
						<button
							type="button"
							onClick={() => setListSort(nextListSort(sort, field))}
							className="inline-flex items-center gap-1 hover:text-foreground"
						>
							{t(`tasks:kanban.list.columns.${field}`)}
							{sort?.field === field &&
								(sort.direction === "asc" ? (
									<ArrowUp className="h-3 w-3" aria-hidden="true" />
								) : (
									<ArrowDown className="h-3 w-3" aria-hidden="true" />
								))}
						</button>
					</th>
				))}
			</tr>
		</thead>
	);
}

function TypeDot({ task }: { task: Task }) {
	const type = resolveCardType(task.metadata)?.type;
	const color = type ? CARD_TYPES.find((item) => item.id === type)?.color : undefined;
	return (
		<span
			className={cn("h-2 w-2 shrink-0 rounded-full", !color && "bg-muted-foreground/30")}
			style={color ? { backgroundColor: color } : undefined}
			aria-hidden="true"
		/>
	);
}

function Row({ row, onOpenTask }: { row: ListRow; onOpenTask?: (task: Task) => void }) {
	const { t } = useTranslation(["tasks"]);
	const sprints = useSprintStore((s) => s.sprints);
	const { task, column } = row;
	const metadata = task.metadata;
	const sprint = metadata?.sprintId ? sprints.find((item) => item.id === metadata.sprintId) : undefined;
	const sprintLabel = metadata?.sprintId ? (sprint?.name ?? t("tasks:kanban.sprints.unknown")) : NONE;
	const points = taskPoints(task);
	return (
		<tr className="border-b border-border/30 text-sm hover:bg-muted/40">
			<td className="max-w-[28rem] px-3 py-1.5">
				<button
					type="button"
					onClick={() => onOpenTask?.(task)}
					className="flex w-full min-w-0 items-center gap-2 text-left hover:text-primary"
				>
					<TypeDot task={task} />
					<span className="truncate font-medium">{task.title}</span>
					{metadata?.flagged && (
						<Flag className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t("tasks:kanban.lanes.flagged")} />
					)}
				</button>
			</td>
			<td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{t(TASK_STATUS_LABELS[column])}</td>
			<td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
				{metadata?.priority ? t(`tasks:form.classification.values.priority.${metadata.priority}`) : NONE}
			</td>
			<td className="max-w-[12rem] truncate px-3 py-1.5 text-muted-foreground">{sprintLabel}</td>
			<td className="max-w-[12rem] truncate px-3 py-1.5 text-muted-foreground">{metadata?.area || NONE}</td>
			<td className="px-3 py-1.5 tabular-nums text-muted-foreground">{points || NONE}</td>
			<td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-muted-foreground">
				{task.updatedAt ? formatAppDate(task.updatedAt) : NONE}
			</td>
		</tr>
	);
}

export function BoardList({ sections, columnOrder, collapsed, onToggleSection, onOpenTask }: BoardListProps) {
	const { t } = useTranslation(["tasks"]);
	const sort = useKanbanLanesStore((s) => s.listSort);
	const sprints = useSprintStore((s) => s.sprints);
	const sorted = useMemo(() => {
		const context = { columnOrder, sprints: orderedSprints(sprints) };
		return sections.map((section) => ({ ...section, rows: sortRows(section.rows, sort, context) }));
	}, [sections, sort, columnOrder, sprints]);
	const empty = sorted.every((section) => section.rows.length === 0);

	return (
		<div className="flex-1 overflow-auto min-h-0 p-2" data-testid="kanban-list">
			<table className="w-full border-collapse">
				<caption className="sr-only">{t("tasks:kanban.list.caption")}</caption>
				<ListHeader />
				{sorted.map((section) => {
					const folded = collapsed.includes(section.key);
					return (
						<tbody key={section.key} aria-label={section.label}>
							{section.label !== undefined && (
								<tr>
									<th colSpan={LIST_SORT_FIELDS.length} scope="rowgroup" className="px-1 pt-3 pb-1 text-left">
										<button
											type="button"
											onClick={() => onToggleSection(section.key)}
											aria-expanded={!folded}
											className="flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary"
										>
											{folded ? (
												<ChevronRight className="h-4 w-4" aria-hidden="true" />
											) : (
												<ChevronDown className="h-4 w-4" aria-hidden="true" />
											)}
											{section.marker}
											<span className="max-w-[24rem] truncate">{section.label}</span>
											<span className="rounded-full bg-muted px-1.5 text-2xs font-bold tabular-nums text-muted-foreground">
												{section.rows.length}
											</span>
										</button>
									</th>
								</tr>
							)}
							{!folded && section.rows.map((row) => <Row key={row.task.id} row={row} onOpenTask={onOpenTask} />)}
						</tbody>
					);
				})}
			</table>
			{empty && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("tasks:kanban.list.empty")}</p>}
		</div>
	);
}
