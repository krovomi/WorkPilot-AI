/**
 * The board as a timeline (Jira's timeline): one row per card, its bar from
 * when work started to when it ended (or today, still running), the weeks
 * along the top and the sprints' dates as bands. With lanes, each lane is a
 * foldable section, as in the list. A row's title opens its card.
 *
 * Rendered by BoardLanes when the toolbar's layout is « Timeline ».
 * Design: docs/architecture/kanban-timeline.md.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TASK_STATUS_LABELS } from "../../../shared/constants/task";
import type { Task } from "../../../shared/types";
import { formatAppDate } from "../../lib/date-format";
import { getBoardColumn } from "../../lib/kanban-columns";
import { barOf, position, sprintBands, timelineWindow, weekTicks } from "../../lib/kanban-timeline";
import { cn } from "../../lib/utils";
import { useSprintStore } from "../../stores/sprint-store";
import type { ListSection } from "./BoardList";

interface BoardTimelineProps {
	sections: ListSection[];
	collapsed: readonly string[];
	onToggleSection: (key: string) => void;
	onOpenTask?: (task: Task) => void;
}

/** A bar's colour, by where its card stands: finished, ended without success, or running. */
function barTone(task: Task): string {
	const column = getBoardColumn(task);
	if (column === "done") return "bg-success/70";
	if (column === "failed" || column === "abandoned") return "bg-muted-foreground/40";
	return "bg-primary/70";
}

export function BoardTimeline({ sections, collapsed, onToggleSection, onOpenTask }: BoardTimelineProps) {
	const { t } = useTranslation(["tasks"]);
	const sprints = useSprintStore((s) => s.sprints);
	const [now] = useState(() => Date.now());
	const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
	const range = useMemo(() => timelineWindow(rows.map((row) => row.task), now), [rows, now]);
	const bands = useMemo(() => sprintBands(sprints, range), [sprints, range]);
	const ticks = useMemo(() => weekTicks(range), [range]);
	const today = position(now, range);
	const dateOf = (at: number) => formatAppDate(at, { month: "short", day: "numeric" });

	return (
		<div className="flex-1 overflow-auto min-h-0 p-2" data-testid="kanban-timeline">
			<div className="min-w-[48rem]">
				<div className="sticky top-0 z-10 flex border-b border-border/60 bg-background">
					<div className="w-56 shrink-0 px-3 py-2 text-xs font-medium text-muted-foreground">
						{t("tasks:kanban.timeline.card")}
					</div>
					<div className="relative h-12 flex-1" aria-hidden="true">
						{bands.map((band) => (
							<div
								key={band.sprint.id}
								className={cn(
									"absolute top-1 h-4 truncate rounded px-1 text-2xs leading-4",
									band.sprint.state === "active" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
								)}
								style={{ left: `${band.left}%`, width: `${band.width}%` }}
								title={band.sprint.name}
							>
								{band.sprint.name}
							</div>
						))}
						{ticks.map((tick) => (
							<span
								key={tick.day}
								className="absolute bottom-1 -translate-x-1/2 text-2xs text-muted-foreground"
								style={{ left: `${tick.left}%` }}
							>
								{formatAppDate(`${tick.day}T00:00:00`, { month: "short", day: "numeric" })}
							</span>
						))}
					</div>
				</div>
				{sections.map((section) => {
					const folded = collapsed.includes(section.key);
					return (
						<section key={section.key} aria-label={section.label}>
							{section.label !== undefined && (
								<button
									type="button"
									onClick={() => onToggleSection(section.key)}
									aria-expanded={!folded}
									className="flex items-center gap-2 px-1 pt-3 pb-1 text-sm font-semibold text-foreground hover:text-primary"
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
							)}
							{!folded && (
								<ul>
									{section.rows.map((row) => {
										const bar = barOf(row.task, now);
										const left = position(bar.start, range);
										const width = Math.max(0.6, position(bar.end, range) - left);
										const span = t(bar.open ? "tasks:kanban.timeline.running" : "tasks:kanban.timeline.span", {
											status: t(TASK_STATUS_LABELS[row.column]),
											start: dateOf(bar.start),
											end: dateOf(bar.end),
										});
										return (
											<li key={row.task.id} className="flex items-center border-b border-border/30 hover:bg-muted/40">
												<button
													type="button"
													onClick={() => onOpenTask?.(row.task)}
													className="w-56 shrink-0 truncate px-3 py-1.5 text-left text-sm font-medium hover:text-primary"
												>
													{row.task.title}
												</button>
												<div className="relative h-7 flex-1">
													<div
														className="absolute top-0 bottom-0 w-px bg-destructive/50"
														style={{ left: `${today}%` }}
														aria-hidden="true"
													/>
													<div
														role="img"
														aria-label={span}
														title={span}
														className={cn("absolute top-2 h-3 rounded-full", barTone(row.task))}
														style={{ left: `${left}%`, width: `${width}%` }}
													/>
												</div>
											</li>
										);
									})}
								</ul>
							)}
						</section>
					);
				})}
				{rows.length === 0 && (
					<p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("tasks:kanban.list.empty")}</p>
				)}
			</div>
		</div>
	);
}
