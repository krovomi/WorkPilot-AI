/**
 * One side of the sprint planning view (the backlog, or the sprint): its
 * cards with their points, a box to tick each, and three ways to send cards
 * to the other side, by its arrow, by dragging them across (the ticked ones
 * go together) or by the keyboard (→ from the backlog, ← from the sprint).
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { ArrowLeft, ArrowRight, GripVertical } from "lucide-react";
import { type DragEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { taskPoints } from "../../../shared/utils/sprints";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

/** The drag payload between the two sides: which side, which cards. */
export const PLANNING_DRAG_TYPE = "application/x-workpilot-planning";

interface DragPayload {
	from: string;
	ids: string[];
}

function readPayload(event: DragEvent): DragPayload | null {
	try {
		const raw = JSON.parse(event.dataTransfer.getData(PLANNING_DRAG_TYPE)) as Partial<DragPayload>;
		if (typeof raw.from !== "string" || !Array.isArray(raw.ids)) return null;
		return { from: raw.from, ids: raw.ids.filter((id): id is string => typeof id === "string") };
	} catch {
		return null;
	}
}

export interface PlanningPaneProps {
	testId: string;
	title: string;
	summary: string;
	empty: string;
	tasks: readonly Task[];
	selected: ReadonlySet<string>;
	onToggle: (taskId: string) => void;
	onToggleAll: (checked: boolean) => void;
	/** Moves cards to the other side. */
	onMove: (taskIds: readonly string[]) => void;
	/** Takes cards dropped here from the other side. */
	onReceive: (taskIds: readonly string[]) => void;
	moveLabel: string;
	direction: "right" | "left";
	busy: boolean;
	/** False for a person who only reads the board: nothing moves. */
	canEdit: boolean;
	/** Chips after a card's title (carried over, waiting on…). */
	renderChips?: (task: Task) => ReactNode;
	/** Shown in place of the points of a card without any (« Estimate »). */
	renderUnestimated?: (task: Task) => ReactNode;
	header?: ReactNode;
	/** List items after the cards (the proposal's rows, « Proposer le sprint »). */
	after?: ReactNode;
	footer: ReactNode;
}

export function PlanningPane({
	testId,
	title,
	summary,
	empty,
	tasks,
	selected,
	onToggle,
	onToggleAll,
	onMove,
	onReceive,
	moveLabel,
	direction,
	busy,
	canEdit,
	renderChips,
	renderUnestimated,
	header,
	after,
	footer,
}: PlanningPaneProps) {
	const { t } = useTranslation(["tasks"]);
	const [over, setOver] = useState(false);
	const all = tasks.length > 0 && tasks.every((task) => selected.has(task.id));
	const some = !all && tasks.some((task) => selected.has(task.id));
	const Arrow = direction === "right" ? ArrowRight : ArrowLeft;
	const locked = busy || !canEdit;

	const startDrag = (event: DragEvent, task: Task) => {
		const ids = selected.has(task.id) ? tasks.filter((item) => selected.has(item.id)).map((item) => item.id) : [task.id];
		event.dataTransfer.setData(PLANNING_DRAG_TYPE, JSON.stringify({ from: testId, ids } satisfies DragPayload));
		event.dataTransfer.effectAllowed = "move";
	};
	// Only cards from the other side land here.
	const accepts = (event: DragEvent) => !locked && event.dataTransfer.types.includes(PLANNING_DRAG_TYPE);

	// The side takes the cards dropped from the other one (handlers spread like dnd-kit listeners).
	const dropTarget = {
		onDragOver: (event: DragEvent) => {
			if (!accepts(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			setOver(true);
		},
		onDragLeave: (event: DragEvent) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
		},
		onDrop: (event: DragEvent) => {
			setOver(false);
			const payload = readPayload(event);
			if (!payload || payload.from === testId || locked) return;
			event.preventDefault();
			onReceive(payload.ids);
		},
	};

	return (
		<section
			data-testid={testId}
			data-drop-over={over || undefined}
			aria-label={title}
			className={cn(
				"flex min-h-0 flex-col rounded-xl border border-border/60 bg-muted/10 transition-shadow",
				over && "ring-2 ring-primary/60",
			)}
			{...dropTarget}
		>
			<div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
				{canEdit && (
					<Checkbox
						checked={all ? true : some ? "indeterminate" : false}
						onCheckedChange={(checked) => onToggleAll(checked === true)}
						disabled={tasks.length === 0 || busy}
						aria-label={t("tasks:kanban.sprints.planning.selectAll")}
					/>
				)}
				<span className="flex-1 truncate text-sm font-semibold">{title}</span>
				<span className="text-xs tabular-nums text-muted-foreground">{summary}</span>
			</div>
			{header}
			<ul className="min-h-[14rem] flex-1 space-y-1 overflow-y-auto p-1.5">
				{tasks.length === 0 && !after && <li className="px-2 py-6 text-center text-xs text-muted-foreground">{empty}</li>}
				{tasks.map((task) => {
					const points = taskPoints(task);
					const priority = task.metadata?.priority;
					const chips = renderChips?.(task);
					return (
						<li
							key={task.id}
							data-task={task.id}
							draggable={!locked}
							{...{ onDragStart: (event: DragEvent) => startDrag(event, task) }}
							className={cn(
								"group flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm",
								selected.has(task.id)
									? "border-primary/40 bg-primary/10"
									: "border-transparent hover:border-border/60 hover:bg-muted/50",
								!locked && "cursor-grab active:cursor-grabbing",
							)}
						>
							{!locked && (
								<GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
							)}
							{canEdit && (
								<Checkbox
									checked={selected.has(task.id)}
									onCheckedChange={() => onToggle(task.id)}
									disabled={busy}
									aria-label={task.title}
								/>
							)}
							<div className="grid min-w-0 flex-1 gap-0.5">
								<button
									type="button"
									onClick={() => canEdit && onToggle(task.id)}
									onKeyDown={(event) => {
										const wanted = direction === "right" ? "ArrowRight" : "ArrowLeft";
										if (event.key !== wanted || locked) return;
										event.preventDefault();
										onMove([task.id]);
									}}
									disabled={busy}
									title={canEdit ? t("tasks:kanban.sprints.planning.keyHint") : undefined}
									className={cn(
										"min-w-0 truncate text-left",
										task.status === "done" && "text-muted-foreground line-through",
									)}
								>
									{task.title}
								</button>
								{chips && <div className="flex flex-wrap items-center gap-1">{chips}</div>}
							</div>
							{priority && (
								<span className="rounded bg-muted px-1.5 text-2xs text-muted-foreground">
									{t(`tasks:form.classification.values.priority.${priority}`)}
								</span>
							)}
							{points === 0 && renderUnestimated ? (
								renderUnestimated(task)
							) : (
								<span
									className="w-12 text-right text-2xs tabular-nums text-muted-foreground"
									title={t("tasks:kanban.sprints.pointsHint")}
								>
									{points > 0 ? t("tasks:kanban.sprints.planning.points", { count: points }) : "–"}
								</span>
							)}
							{canEdit && (
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="h-6 w-6 opacity-60 group-hover:opacity-100"
									onClick={() => onMove([task.id])}
									disabled={busy}
									aria-label={moveLabel}
									title={moveLabel}
								>
									<Arrow className="h-3.5 w-3.5" />
								</Button>
							)}
						</li>
					);
				})}
				{after}
			</ul>
			<div className="border-t border-border/50 p-2">{footer}</div>
		</section>
	);
}
