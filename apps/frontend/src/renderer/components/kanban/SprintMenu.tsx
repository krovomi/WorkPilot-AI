/**
 * The toolbar's « Sprints » menu: which cards the board shows (every card,
 * the backlog, or one sprint's), each sprint's progress in cards and points,
 * the velocity of the last closed sprints, and, for a person who may change
 * the board, creating, starting, closing, editing and deleting sprints.
 *
 * A card joins a sprint from its menu or by being dragged into the sprint's
 * lane (grouping « Sprint »).
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { CalendarRange, IterationCw, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Sprint } from "../../../shared/types";
import { activeSprint, orderedSprints, sprintProgress, velocity } from "../../../shared/utils/sprints";
import { formatAppDate } from "../../lib/date-format";
import { NO_SPRINT } from "../../lib/kanban-filter";
import { cn } from "../../lib/utils";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { useProjectStore } from "../../stores/project-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { confirmAction } from "../ui/confirm-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useSelectedServerProject } from "./ServerBoardNotice";
import { SprintCompleteDialog, SprintEditDialog, useSprintFailure } from "./SprintDialogs";

function days(sprint: Sprint): string | null {
	const format = (day: string) => formatAppDate(`${day}T00:00:00`, { day: "numeric", month: "short" });
	if (sprint.startDate && sprint.endDate) return `${format(sprint.startDate)} – ${format(sprint.endDate)}`;
	if (sprint.startDate) return format(sprint.startDate);
	if (sprint.endDate) return format(sprint.endDate);
	return null;
}

const STATE_TONES: Record<Sprint["state"], string> = {
	active: "bg-primary/15 text-primary",
	planned: "bg-muted text-muted-foreground",
	closed: "bg-success/15 text-success",
};

export function SprintMenu() {
	const { t } = useTranslation(["tasks"]);
	const projectId = useProjectStore((s) => s.selectedProjectId);
	const serverProject = useSelectedServerProject();
	const canEdit = !serverProject || (serverProject.remote?.role ?? "viewer") !== "viewer";
	const sprints = useSprintStore((s) => s.sprints);
	const load = useSprintStore((s) => s.load);
	const start = useSprintStore((s) => s.start);
	const remove = useSprintStore((s) => s.remove);
	const tasks = useTaskStore((s) => s.tasks);
	const filter = useKanbanFilterStore((s) => s.filters.sprint);
	const setSprint = useKanbanFilterStore((s) => s.setSprint);
	const failed = useSprintFailure();
	const [editing, setEditing] = useState<{ sprint?: Sprint } | null>(null);
	const [closing, setClosing] = useState<Sprint | null>(null);

	useEffect(() => {
		if (projectId) void load(projectId);
	}, [projectId, load]);

	const list = useMemo(() => orderedSprints(sprints), [sprints]);
	const active = activeSprint(sprints);
	const speed = velocity(sprints);
	const shown = filter && filter !== NO_SPRINT ? sprints.find((sprint) => sprint.id === filter) : undefined;
	const backlogCount = useMemo(() => tasks.filter((task) => !task.metadata?.sprintId).length, [tasks]);
	const label = shown
		? shown.name
		: filter === NO_SPRINT
			? t("tasks:kanban.sprints.backlog")
			: t("tasks:kanban.sprints.button");

	const askDelete = async (sprint: Sprint) => {
		const confirmed = await confirmAction({
			title: t("tasks:kanban.sprints.deleteTitle", { name: sprint.name }),
			description: t("tasks:kanban.sprints.deleteHint"),
			destructive: true,
		});
		if (!confirmed) return;
		if (failed(await remove(sprint.id)) && filter === sprint.id) setSprint(undefined);
	};

	const filterButton = (value: string | undefined, text: string, count: number) => (
		<button
			type="button"
			aria-pressed={filter === value}
			onClick={() => setSprint(value)}
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
				filter === value ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted/60",
			)}
		>
			<span className="flex-1 truncate">{text}</span>
			<span className="text-xs tabular-nums text-muted-foreground">{count}</span>
		</button>
	);

	return (
		<>
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className={cn(
							"h-8 gap-2 rounded-full text-muted-foreground hover:text-foreground transition-colors",
							filter && "bg-primary/10 text-primary hover:text-primary",
						)}
						title={t("tasks:kanban.sprints.title")}
						data-testid="kanban-sprint-menu"
					>
						<IterationCw className="h-4 w-4" />
						<span className="max-w-[10rem] truncate">{label}</span>
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-96 p-0 overflow-hidden">
					<div className="flex items-center gap-2 border-b border-border/60 bg-linear-to-br from-primary/5 to-transparent px-4 py-2.5">
						<IterationCw className="h-4 w-4 text-primary" aria-hidden="true" />
						<span className="flex-1 text-sm font-semibold">{t("tasks:kanban.sprints.title")}</span>
						{speed !== null && (
							<span className="text-xs text-muted-foreground" title={t("tasks:kanban.sprints.velocityHint")}>
								{t("tasks:kanban.sprints.velocity", { points: speed })}
							</span>
						)}
					</div>
					<div className="max-h-[28rem] space-y-1 overflow-y-auto p-2">
						{filterButton(undefined, t("tasks:kanban.sprints.allCards"), tasks.length)}
						{filterButton(NO_SPRINT, t("tasks:kanban.sprints.backlog"), backlogCount)}
						{list.length === 0 && (
							<p className="px-2 py-3 text-xs text-muted-foreground">{t("tasks:kanban.sprints.empty")}</p>
						)}
						{list.map((sprint) => {
							const progress = sprintProgress(tasks, sprint.id);
							const range = days(sprint);
							const ratio = progress.points > 0 ? progress.donePoints / progress.points : progress.cards > 0 ? progress.done / progress.cards : 0;
							return (
								<div
									key={sprint.id}
									data-sprint={sprint.id}
									className={cn(
										"rounded-lg border px-2 py-2",
										filter === sprint.id ? "border-primary/60 bg-primary/5" : "border-border/50",
									)}
								>
									<div className="flex items-center gap-2">
										<button
											type="button"
											aria-pressed={filter === sprint.id}
											onClick={() => setSprint(sprint.id)}
											className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:text-primary"
										>
											{sprint.name}
										</button>
										<span className={cn("rounded px-1.5 text-2xs font-semibold", STATE_TONES[sprint.state])}>
											{t(`tasks:kanban.sprints.states.${sprint.state}`)}
										</span>
									</div>
									{sprint.goal && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{sprint.goal}</p>}
									<div className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground">
										{range && (
											<span className="inline-flex items-center gap-1">
												<CalendarRange className="h-3 w-3" aria-hidden="true" />
												{range}
											</span>
										)}
										<span className="tabular-nums">
											{t("tasks:kanban.sprints.progress", {
												done: progress.done,
												cards: progress.cards,
												donePoints: progress.donePoints,
												points: progress.points,
											})}
										</span>
										{progress.unestimated > 0 && (
											<span title={t("tasks:kanban.sprints.pointsHint")}>
												{t("tasks:kanban.sprints.unestimated", { count: progress.unestimated })}
											</span>
										)}
									</div>
									{sprint.state !== "planned" && (
										<div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
											<div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(ratio * 100)}%` }} />
										</div>
									)}
									{sprint.state === "closed" && sprint.report && (
										<p className="mt-1 text-2xs text-muted-foreground">
											{t("tasks:kanban.sprints.report", {
												done: sprint.report.done,
												donePoints: sprint.report.donePoints,
												carried: sprint.report.carried,
											})}
										</p>
									)}
									{canEdit && sprint.state !== "closed" && (
										<div className="mt-1.5 flex flex-wrap gap-1">
											{sprint.state === "planned" && (
												<Button
													size="sm"
													variant="outline"
													className="h-6 gap-1 px-2 text-xs"
													disabled={!!active}
													title={active ? t("tasks:kanban.sprints.oneActive") : undefined}
													onClick={async () => failed(await start(sprint.id))}
												>
													<Play className="h-3 w-3" />
													{t("tasks:kanban.sprints.start")}
												</Button>
											)}
											{sprint.state === "active" && (
												<Button
													size="sm"
													variant="outline"
													className="h-6 gap-1 px-2 text-xs"
													onClick={() => setClosing(sprint)}
												>
													<Square className="h-3 w-3" />
													{t("tasks:kanban.sprints.complete")}
												</Button>
											)}
											<Button
												size="sm"
												variant="ghost"
												className="h-6 gap-1 px-2 text-xs"
												onClick={() => setEditing({ sprint })}
											>
												<Pencil className="h-3 w-3" />
												{t("tasks:kanban.sprints.edit")}
											</Button>
											{sprint.state === "planned" && (
												<Button
													size="sm"
													variant="ghost"
													className="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
													onClick={() => void askDelete(sprint)}
												>
													<Trash2 className="h-3 w-3" />
													{t("tasks:kanban.sprints.delete")}
												</Button>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
					{canEdit && (
						<div className="border-t border-border/60 p-2">
							<Button size="sm" variant="ghost" className="w-full justify-start gap-2" onClick={() => setEditing({})}>
								<Plus className="h-4 w-4" />
								{t("tasks:kanban.sprints.new")}
							</Button>
						</div>
					)}
				</PopoverContent>
			</Popover>
			{editing && (
				<SprintEditDialog
					key={editing.sprint?.id ?? "new"}
					sprint={editing.sprint}
					open
					onOpenChange={(open) => !open && setEditing(null)}
				/>
			)}
			{closing && <SprintCompleteDialog sprint={closing} onOpenChange={(open) => !open && setClosing(null)} />}
		</>
	);
}
