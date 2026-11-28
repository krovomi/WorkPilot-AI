/**
 * The sprint planning view: the backlog on one side, the sprint's cards on
 * the other. Ticking cards and pressing « Add to the sprint » (or the arrow
 * of one card) moves them; the sprint's points are shown next to the
 * velocity of the last sprints, so the person sees when it holds more than
 * the team usually finishes.
 *
 * Opened from the board's sprint banner, the « Sprints » menu, and right
 * after a sprint is created; one is open at a time (`planningId` of the
 * sprint store). Mounted once by BoardLanes.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Sprint, Task } from "../../../shared/types";
import { orderedSprints, taskPoints, velocity } from "../../../shared/utils/sprints";
import { matchesSearch, planningPools } from "../../lib/sprint-planning";
import { cn } from "../../lib/utils";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { useSprintFailure } from "./SprintDialogs";

const NO_IDS: ReadonlySet<string> = new Set();

interface PaneProps {
	testId: string;
	title: string;
	summary: string;
	empty: string;
	tasks: readonly Task[];
	selected: ReadonlySet<string>;
	onToggle: (taskId: string) => void;
	onToggleAll: (checked: boolean) => void;
	/** Moves one card to the other side. */
	onMove: (taskId: string) => void;
	moveLabel: string;
	direction: "right" | "left";
	busy: boolean;
	header?: React.ReactNode;
	footer: React.ReactNode;
}

function Pane({
	testId,
	title,
	summary,
	empty,
	tasks,
	selected,
	onToggle,
	onToggleAll,
	onMove,
	moveLabel,
	direction,
	busy,
	header,
	footer,
}: PaneProps) {
	const { t } = useTranslation(["tasks"]);
	const all = tasks.length > 0 && tasks.every((task) => selected.has(task.id));
	const some = !all && tasks.some((task) => selected.has(task.id));
	const Arrow = direction === "right" ? ArrowRight : ArrowLeft;
	return (
		<section
			data-testid={testId}
			aria-label={title}
			className="flex min-h-0 flex-col rounded-xl border border-border/60 bg-muted/10"
		>
			<div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
				<Checkbox
					checked={all ? true : some ? "indeterminate" : false}
					onCheckedChange={(checked) => onToggleAll(checked === true)}
					disabled={tasks.length === 0 || busy}
					aria-label={t("tasks:kanban.sprints.planning.selectAll")}
				/>
				<span className="flex-1 truncate text-sm font-semibold">{title}</span>
				<span className="text-xs tabular-nums text-muted-foreground">{summary}</span>
			</div>
			{header}
			<ul className="min-h-[14rem] flex-1 space-y-0.5 overflow-y-auto p-1.5">
				{tasks.length === 0 && <li className="px-2 py-6 text-center text-xs text-muted-foreground">{empty}</li>}
				{tasks.map((task) => {
					const points = taskPoints(task);
					const priority = task.metadata?.priority;
					return (
						<li
							key={task.id}
							data-task={task.id}
							className={cn(
								"group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
								selected.has(task.id) ? "bg-primary/10" : "hover:bg-muted/50",
							)}
						>
							<Checkbox
								checked={selected.has(task.id)}
								onCheckedChange={() => onToggle(task.id)}
								disabled={busy}
								aria-label={task.title}
							/>
							<button
								type="button"
								onClick={() => onToggle(task.id)}
								disabled={busy}
								className={cn("min-w-0 flex-1 truncate text-left", task.status === "done" && "text-muted-foreground line-through")}
							>
								{task.title}
							</button>
							{priority && (
								<span className="rounded bg-muted px-1.5 text-2xs text-muted-foreground">
									{t(`tasks:form.classification.values.priority.${priority}`)}
								</span>
							)}
							<span
								className="w-12 text-right text-2xs tabular-nums text-muted-foreground"
								title={t("tasks:kanban.sprints.pointsHint")}
							>
								{points > 0 ? t("tasks:kanban.sprints.planning.points", { count: points }) : "–"}
							</span>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="h-6 w-6 opacity-60 group-hover:opacity-100"
								onClick={() => onMove(task.id)}
								disabled={busy}
								aria-label={moveLabel}
								title={moveLabel}
							>
								<Arrow className="h-3.5 w-3.5" />
							</Button>
						</li>
					);
				})}
			</ul>
			<div className="border-t border-border/50 p-2">{footer}</div>
		</section>
	);
}

function toggled(ids: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(ids);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

function SprintPicker({ current, onPick }: { current: Sprint; onPick: (id: string) => void }) {
	const sprints = useSprintStore((s) => s.sprints);
	const open = useMemo(() => orderedSprints(sprints).filter((sprint) => sprint.state !== "closed"), [sprints]);
	if (open.length < 2) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{open.map((sprint) => (
				<button
					key={sprint.id}
					type="button"
					aria-pressed={sprint.id === current.id}
					onClick={() => onPick(sprint.id)}
					className={cn(
						"max-w-[12rem] truncate rounded-full border px-3 py-1 text-xs transition-colors",
						sprint.id === current.id
							? "border-primary bg-primary/10 text-primary"
							: "border-border/60 text-muted-foreground hover:text-foreground",
					)}
				>
					{sprint.name}
				</button>
			))}
		</div>
	);
}

/** The planning view of the sprint named by the store's `planningId`; nothing while none is. */
export function SprintPlanningDialog() {
	const planningId = useSprintStore((s) => s.planningId);
	const sprints = useSprintStore((s) => s.sprints);
	const closePlanning = useSprintStore((s) => s.closePlanning);
	const sprint = sprints.find((item) => item.id === planningId && item.state !== "closed");

	// A sprint that closed or vanished meanwhile: the view closes.
	useEffect(() => {
		if (planningId && !sprint) closePlanning();
	}, [planningId, sprint, closePlanning]);

	// Keyed by the sprint: another sprint starts from nothing ticked.
	return sprint ? <PlanningView key={sprint.id} sprint={sprint} /> : null;
}

function PlanningView({ sprint }: { sprint: Sprint }) {
	const { t } = useTranslation(["tasks", "common"]);
	const sprints = useSprintStore((s) => s.sprints);
	const openPlanning = useSprintStore((s) => s.openPlanning);
	const closePlanning = useSprintStore((s) => s.closePlanning);
	const assign = useSprintStore((s) => s.assign);
	const tasks = useTaskStore((s) => s.tasks);
	const failed = useSprintFailure();
	const [search, setSearch] = useState("");
	const [fromBacklog, setFromBacklog] = useState<ReadonlySet<string>>(NO_IDS);
	const [fromSprint, setFromSprint] = useState<ReadonlySet<string>>(NO_IDS);
	const [busy, setBusy] = useState(false);
	const pools = useMemo(() => planningPools(tasks, sprint.id), [tasks, sprint.id]);
	const speed = velocity(sprints);

	const backlog = pools.backlog.filter((task) => matchesSearch(task, search));
	const backlogPoints = backlog.reduce((sum, task) => sum + taskPoints(task), 0);
	const over = speed !== null && pools.points > speed;

	const move = async (ids: readonly string[], to: string | null) => {
		if (ids.length === 0 || busy) return;
		setBusy(true);
		const outcome = await assign(ids, to);
		setBusy(false);
		if (failed(outcome)) {
			const moved = new Set(ids);
			const keep = (set: ReadonlySet<string>) => new Set([...set].filter((id) => !moved.has(id)));
			setFromBacklog(keep);
			setFromSprint(keep);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && closePlanning()}>
			<DialogContent className="sm:max-w-4xl" data-testid="sprint-planning">
				<DialogHeader>
					<DialogTitle>{t("tasks:kanban.sprints.planning.title", { name: sprint.name })}</DialogTitle>
					<DialogDescription>{t("tasks:kanban.sprints.planning.hint")}</DialogDescription>
				</DialogHeader>
				<SprintPicker current={sprint} onPick={openPlanning} />
				<div className="grid max-h-[60vh] min-h-0 gap-3 md:grid-cols-2">
					<Pane
						testId="sprint-planning-backlog"
						title={t("tasks:kanban.sprints.backlog")}
						summary={t("tasks:kanban.sprints.planning.summary", { count: backlog.length, points: backlogPoints })}
						empty={
							search.trim()
								? t("tasks:kanban.sprints.planning.noMatch")
								: t("tasks:kanban.sprints.planning.backlogEmpty")
						}
						tasks={backlog}
						selected={fromBacklog}
						onToggle={(id) => setFromBacklog((set) => toggled(set, id))}
						onToggleAll={(checked) => setFromBacklog(checked ? new Set(backlog.map((task) => task.id)) : NO_IDS)}
						onMove={(id) => void move([id], sprint.id)}
						moveLabel={t("tasks:kanban.sprints.planning.addOne")}
						direction="right"
						busy={busy}
						header={
							<div className="relative border-b border-border/50 px-2 py-1.5">
								<Search className="absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
								<Input
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									placeholder={t("tasks:kanban.sprints.planning.search")}
									aria-label={t("tasks:kanban.sprints.planning.search")}
									className="h-8 pl-8 text-sm"
								/>
							</div>
						}
						footer={
							<Button
								type="button"
								size="sm"
								className="w-full gap-2"
								disabled={fromBacklog.size === 0 || busy}
								onClick={() => void move([...fromBacklog], sprint.id)}
							>
								{t("tasks:kanban.sprints.planning.add", { count: fromBacklog.size })}
								<ArrowRight className="h-4 w-4" />
							</Button>
						}
					/>
					<Pane
						testId="sprint-planning-sprint"
						title={sprint.name}
						summary={t("tasks:kanban.sprints.planning.summary", { count: pools.sprint.length, points: pools.points })}
						empty={t("tasks:kanban.sprints.planning.sprintEmpty")}
						tasks={pools.sprint}
						selected={fromSprint}
						onToggle={(id) => setFromSprint((set) => toggled(set, id))}
						onToggleAll={(checked) => setFromSprint(checked ? new Set(pools.sprint.map((task) => task.id)) : NO_IDS)}
						onMove={(id) => void move([id], null)}
						moveLabel={t("tasks:kanban.sprints.planning.removeOne")}
						direction="left"
						busy={busy}
						header={
							speed !== null ? (
								<p
									className={cn(
										"border-b border-border/50 px-3 py-1.5 text-xs",
										over ? "text-warning" : "text-muted-foreground",
									)}
									title={t("tasks:kanban.sprints.velocityHint")}
								>
									{over
										? t("tasks:kanban.sprints.planning.overVelocity", { points: pools.points, velocity: speed })
										: t("tasks:kanban.sprints.planning.underVelocity", { points: pools.points, velocity: speed })}
								</p>
							) : undefined
						}
						footer={
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="w-full gap-2"
								disabled={fromSprint.size === 0 || busy}
								onClick={() => void move([...fromSprint], null)}
							>
								<ArrowLeft className="h-4 w-4" />
								{t("tasks:kanban.sprints.planning.remove", { count: fromSprint.size })}
							</Button>
						}
					/>
				</div>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={closePlanning}>
						{t("common:buttons.close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
