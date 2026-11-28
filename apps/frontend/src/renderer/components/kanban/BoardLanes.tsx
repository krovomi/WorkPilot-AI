/**
 * The board's columns, in one row or cut into lanes (Jira's swimlanes) by
 * the grouping picked in the toolbar (LaneGroupingMenu). Each lane holds
 * every column; its columns are drop targets of their own (`laneDropId`),
 * the moves across lanes go through `hooks/useLaneDrag.ts`.
 *
 * KanbanBoard renders its columns through `renderColumn`, so a column in a
 * lane is the same column as without lanes.
 *
 * Design: docs/architecture/kanban-swimlanes.md.
 */
import { ChevronDown, ChevronRight, Flag } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CARD_TYPES } from "../../../shared/constants/card-types";
import type { TaskStatusColumn } from "../../../shared/constants/task";
import type { Task } from "../../../shared/types";
import { buildLanes, FLAGGED_LANE, type Lane, type LaneGrouping, laneDropId, NO_VALUE_LANE } from "../../lib/kanban-lanes";
import { cn } from "../../lib/utils";
import { orderedSprints } from "../../../shared/utils/sprints";
import { useKanbanLanesStore } from "../../stores/kanban-lanes-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";

const NO_TASKS: Task[] = [];
/** A priority lane's dot, in the colours of the card's priority badge. */
const PRIORITY_DOTS: Record<string, string> = {
	urgent: "bg-destructive",
	high: "bg-warning",
	medium: "bg-info",
	low: "bg-muted-foreground/40",
};
/** A lane's height, from its fullest column: its columns scroll inside it, as the board's do. */
function laneHeight(lane: Lane): string {
	const fullest = Math.max(0, ...Object.values(lane.columns).map((cards) => cards?.length ?? 0));
	if (fullest === 0) return "8rem";
	return fullest === 1 ? "22rem" : "32rem";
}

interface BoardLanesProps {
	projectId: string | null;
	columnOrder: readonly TaskStatusColumn[];
	tasksByStatus: Record<TaskStatusColumn, Task[]>;
	/** One column; `droppableId` is set inside a lane. */
	renderColumn: (status: TaskStatusColumn, tasks: Task[], droppableId?: string) => ReactNode;
}

/** The sub-projects the project index knows (a monorepo's services), loaded once per project. */
function useIndexedAreas(projectId: string | null, wanted: boolean): string[] {
	const [areas, setAreas] = useState<{ projectId: string; names: string[] } | null>(null);
	useEffect(() => {
		if (!wanted || !projectId || areas?.projectId === projectId) return;
		let live = true;
		(async () => {
			try {
				const result = await globalThis.electronAPI?.getProjectContext(projectId);
				const services = result?.success ? result.data?.projectIndex?.services : undefined;
				const names = services
					? Object.entries(services).map(([key, service]) => service?.name || key)
					: [];
				if (live) setAreas({ projectId, names });
			} catch {
				if (live) setAreas({ projectId, names: [] });
			}
		})();
		return () => {
			live = false;
		};
	}, [projectId, wanted, areas?.projectId]);
	return areas?.projectId === projectId ? areas.names : NO_AREAS;
}
const NO_AREAS: string[] = [];

function LaneMarker({ grouping, lane }: { grouping: LaneGrouping; lane: Lane }) {
	if (lane.key === FLAGGED_LANE) return <Flag className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />;
	const color = grouping === "type" ? CARD_TYPES.find((type) => type.id === lane.value)?.color : undefined;
	const tone = grouping === "priority" && lane.value ? PRIORITY_DOTS[lane.value] : undefined;
	return (
		<span
			className={cn("h-2.5 w-2.5 shrink-0 rounded-full", !color && (tone ?? "bg-muted-foreground/40"))}
			style={color ? { backgroundColor: color } : undefined}
			aria-hidden="true"
		/>
	);
}

function useLaneLabel(grouping: LaneGrouping) {
	const { t } = useTranslation(["tasks"]);
	const tasks = useTaskStore((s) => s.tasks);
	const sprints = useSprintStore((s) => s.sprints);
	return (lane: Lane): string => {
		if (lane.key === FLAGGED_LANE) return t("tasks:kanban.lanes.flagged");
		if (lane.key === NO_VALUE_LANE || !lane.value) return t(`tasks:kanban.lanes.noValue.${grouping}`);
		const value = lane.value;
		switch (grouping) {
			case "priority":
				return t(`tasks:form.classification.values.priority.${value}`);
			case "type":
				return t(`tasks:cardType.values.${value}`);
			case "source":
				return t(`tasks:kanban.filter.sources.${value}`);
			case "sprint": {
				const sprint = sprints.find((item) => item.id === value);
				if (!sprint) return t("tasks:kanban.sprints.unknown");
				return `${sprint.name} · ${t(`tasks:kanban.sprints.states.${sprint.state}`)}`;
			}
			case "parent": {
				const parent = tasks.find((task) => task.specId === value || task.id === value);
				return parent?.title || value;
			}
			default:
				return value;
		}
	};
}

export function BoardLanes({ projectId, columnOrder, tasksByStatus, renderColumn }: BoardLanesProps) {
	const { t } = useTranslation(["tasks"]);
	const loadForProject = useKanbanLanesStore((s) => s.loadForProject);
	const grouping = useKanbanLanesStore((s) => s.grouping);
	const pinFlagged = useKanbanLanesStore((s) => s.pinFlagged);
	const collapsed = useKanbanLanesStore((s) => s.collapsed[s.grouping]);
	const extraAreas = useKanbanLanesStore((s) => s.areas);
	const toggleCollapsed = useKanbanLanesStore((s) => s.toggleCollapsed);
	const sprints = useSprintStore((s) => s.sprints);
	const knownSprints = useMemo(() => orderedSprints(sprints), [sprints]);
	useEffect(() => loadForProject(projectId), [projectId, loadForProject]);

	const indexedAreas = useIndexedAreas(projectId, grouping === "area");
	const lanes = useMemo(
		() =>
			buildLanes(tasksByStatus, {
				grouping,
				pinFlagged,
				knownAreas: [...indexedAreas, ...extraAreas],
				knownSprints,
			}),
		[tasksByStatus, grouping, pinFlagged, indexedAreas, extraAreas, knownSprints],
	);
	const labelOf = useLaneLabel(grouping);

	if (grouping === "none") {
		return (
			<div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden min-h-0 p-2">
				{columnOrder.map((status) => renderColumn(status, tasksByStatus[status]))}
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col gap-2 overflow-auto min-h-0 p-2" data-testid="kanban-lanes">
			{lanes.map((lane) => {
				const folded = collapsed?.includes(lane.key) ?? false;
				const label = labelOf(lane);
				return (
					<section
						key={lane.key}
						aria-label={label}
						data-lane={lane.key}
						className="w-max min-w-full shrink-0 rounded-xl border border-border/50 bg-muted/10"
					>
						<button
							type="button"
							onClick={() => toggleCollapsed(lane.key)}
							aria-expanded={!folded}
							title={folded ? t("tasks:kanban.lanes.expand") : t("tasks:kanban.lanes.collapse")}
							className="sticky left-0 flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-foreground hover:text-primary"
						>
							{folded ? (
								<ChevronRight className="h-4 w-4" aria-hidden="true" />
							) : (
								<ChevronDown className="h-4 w-4" aria-hidden="true" />
							)}
							<LaneMarker grouping={grouping} lane={lane} />
							<span className="max-w-[24rem] truncate">{label}</span>
							<span className="rounded-full bg-muted px-1.5 text-2xs font-bold tabular-nums text-muted-foreground">
								{lane.count}
							</span>
						</button>
						{!folded && (
							<div
								className="flex gap-3 px-2 pb-2"
								style={{ height: laneHeight(lane) }}
							>
								{columnOrder.map((status) =>
									renderColumn(status, lane.columns[status] ?? NO_TASKS, laneDropId(lane.key, status)),
								)}
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}
