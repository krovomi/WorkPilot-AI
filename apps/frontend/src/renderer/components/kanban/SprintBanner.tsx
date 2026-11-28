/**
 * The band above the board that names the sprint it is about: the one the
 * « Sprints » filter shows, else the active one. It gives the sprint's days
 * (and the calendar days left), what it holds and what is done, and the
 * next step: show only its cards, plan it (the planning view), have it
 * proposed (« Proposer le sprint », the planning view on its settings),
 * start it or complete it. Nothing shows while the board has no sprint to talk about.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { CalendarRange, Filter, IterationCw, ListPlus, Play, Sparkles, Square } from "lucide-react";
import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Sprint } from "../../../shared/types";
import { activeSprint, sprintProgress } from "../../../shared/utils/sprints";
import { formatAppDate } from "../../lib/date-format";
import { daysLeft, focusedSprint } from "../../lib/sprint-planning";
import { cn } from "../../lib/utils";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { useSprintProposalStore } from "../../stores/sprint-proposal-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { useSelectedServerProject } from "./ServerBoardNotice";
import { SprintCompleteDialog, useSprintFailure } from "./SprintDialogs";

function range(sprint: Sprint): string | null {
	const format = (day: string) => formatAppDate(`${day}T00:00:00`, { day: "numeric", month: "short" });
	if (sprint.startDate && sprint.endDate) return `${format(sprint.startDate)} – ${format(sprint.endDate)}`;
	if (sprint.endDate) return format(sprint.endDate);
	if (sprint.startDate) return format(sprint.startDate);
	return null;
}

function daysLeftLabel(sprint: Sprint, t: TFunction): string | null {
	if (sprint.state !== "active") return null;
	const left = daysLeft(sprint, Date.now());
	if (left === null) return null;
	if (left < 0) return t("tasks:kanban.sprints.banner.overdue", { count: -left });
	if (left === 0) return t("tasks:kanban.sprints.banner.lastDay");
	return t("tasks:kanban.sprints.banner.daysLeft", { count: left });
}

export function SprintBanner() {
	const { t } = useTranslation(["tasks"]);
	const sprints = useSprintStore((s) => s.sprints);
	const openPlanning = useSprintStore((s) => s.openPlanning);
	const start = useSprintStore((s) => s.start);
	const openSettings = useSprintProposalStore((s) => s.openSettings);
	const tasks = useTaskStore((s) => s.tasks);
	const filter = useKanbanFilterStore((s) => s.filters.sprint);
	const setSprint = useKanbanFilterStore((s) => s.setSprint);
	const serverProject = useSelectedServerProject();
	const canEdit = !serverProject || (serverProject.remote?.role ?? "viewer") !== "viewer";
	const failed = useSprintFailure();
	const [closing, setClosing] = useState<Sprint | null>(null);
	const sprint = focusedSprint(sprints, filter);
	if (!sprint) return null;

	const left = daysLeftLabel(sprint, t);
	const progress = sprintProgress(tasks, sprint.id);
	const ratio =
		progress.points > 0 ? progress.donePoints / progress.points : progress.cards > 0 ? progress.done / progress.cards : 0;
	const days = range(sprint);
	const shown = filter === sprint.id;
	const otherActive = sprint.state === "planned" && !!activeSprint(sprints);

	return (
		<div
			data-testid="kanban-sprint-banner"
			data-sprint={sprint.id}
			className="mx-2 mb-1 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-primary/30 bg-linear-to-r from-primary/10 via-primary/5 to-transparent px-3 py-2"
		>
			<div className="flex min-w-0 items-center gap-2">
				<IterationCw className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
				<span className="max-w-[16rem] truncate text-sm font-semibold">{sprint.name}</span>
				<span
					className={cn(
						"rounded px-1.5 text-2xs font-semibold",
						sprint.state === "active" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
					)}
				>
					{t(`tasks:kanban.sprints.states.${sprint.state}`)}
				</span>
			</div>
			{sprint.goal && (
				<p className="min-w-0 max-w-[28rem] flex-1 truncate text-xs text-muted-foreground" title={sprint.goal}>
					{sprint.goal}
				</p>
			)}
			{(days || left) && (
				<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
					<CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
					{days}
					{days && left && <span aria-hidden="true">·</span>}
					{left && <span className="font-medium text-foreground">{left}</span>}
				</span>
			)}
			{progress.cards > 0 ? (
				<div className="flex items-center gap-2">
					<div
						className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(ratio * 100)}
						aria-label={t("tasks:kanban.sprints.banner.progressLabel")}
					>
						<div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(ratio * 100)}%` }} />
					</div>
					<span className="text-xs tabular-nums text-muted-foreground">
						{t("tasks:kanban.sprints.progress", {
							done: progress.done,
							cards: progress.cards,
							donePoints: progress.donePoints,
							points: progress.points,
						})}
					</span>
				</div>
			) : (
				<span className="text-xs text-muted-foreground">
					{canEdit ? t("tasks:kanban.sprints.banner.emptyPlan") : t("tasks:kanban.sprints.banner.empty")}
				</span>
			)}
			<div className="ml-auto flex flex-wrap items-center gap-1">
				<Button
					size="sm"
					variant="ghost"
					className={cn("h-7 gap-1.5 px-2 text-xs", shown && "bg-primary/10 text-primary")}
					aria-pressed={shown}
					onClick={() => setSprint(shown ? undefined : sprint.id)}
				>
					<Filter className="h-3.5 w-3.5" />
					{shown ? t("tasks:kanban.sprints.banner.showAll") : t("tasks:kanban.sprints.banner.showOnly")}
				</Button>
				{canEdit && sprint.state !== "closed" && (
					<Button
						size="sm"
						variant={progress.cards === 0 ? "default" : "outline"}
						className="h-7 gap-1.5 px-2 text-xs"
						onClick={() => openPlanning(sprint.id)}
						data-testid="kanban-sprint-plan"
					>
						<ListPlus className="h-3.5 w-3.5" />
						{t("tasks:kanban.sprints.planning.open")}
					</Button>
				)}
				{canEdit && sprint.state !== "closed" && (
					<Button
						size="sm"
						variant="outline"
						className="h-7 gap-1.5 border-violet-500/40 px-2 text-xs text-violet-700 dark:text-violet-300 hover:bg-violet-500/10"
						onClick={() => {
							openSettings(sprint.id);
							openPlanning(sprint.id);
						}}
						data-testid="kanban-sprint-propose"
					>
						<Sparkles className="h-3.5 w-3.5" />
						{t("tasks:kanban.sprints.proposal.open")}
					</Button>
				)}
				{canEdit && sprint.state === "planned" && (
					<Button
						size="sm"
						variant="outline"
						className="h-7 gap-1.5 px-2 text-xs"
						disabled={otherActive}
						title={otherActive ? t("tasks:kanban.sprints.oneActive") : undefined}
						onClick={async () => failed(await start(sprint.id))}
					>
						<Play className="h-3.5 w-3.5" />
						{t("tasks:kanban.sprints.start")}
					</Button>
				)}
				{canEdit && sprint.state === "active" && (
					<Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setClosing(sprint)}>
						<Square className="h-3.5 w-3.5" />
						{t("tasks:kanban.sprints.complete")}
					</Button>
				)}
			</div>
			{closing && <SprintCompleteDialog sprint={closing} onOpenChange={(open) => !open && setClosing(null)} />}
		</div>
	);
}
