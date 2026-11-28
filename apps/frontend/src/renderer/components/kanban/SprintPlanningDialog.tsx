/**
 * The sprint planning view: the backlog on one side, the sprint's cards on
 * the other, and above them the capacity gauge (the sprint's points against
 * the velocity of the last sprints, or the capacity the team set). Cards
 * move by their arrow, by ticking several then « Add to the sprint », by
 * dragging them across, or by the keyboard; the last move is undone with
 * « Undo » or Ctrl+Z.
 *
 * The backlog has quick filters (urgent, bugs, not estimated) and a card
 * without points offers « Estimate ». The sprint side marks a card carried
 * over from the last sprint and one waiting on a card left out, with « Add
 * these too ». A planned sprint starts from here. « Proposer le sprint »
 * (SprintProposalPanel) offers the cards that fill it, in dashed violet,
 * until the person adds them.
 *
 * Opened from the board's sprint banner, the « Sprints » menu, and right
 * after a sprint is created; one is open at a time (`planningId` of the
 * sprint store). Mounted once by BoardLanes.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { ArrowLeft, ArrowRight, CornerDownRight, Link2, Play, Search, Undo2 } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Sprint, Task } from "../../../shared/types";
import { activeSprint, orderedSprints, sprintProgress, taskPoints } from "../../../shared/utils/sprints";
import {
	carriedFromSprint,
	matchesQuick,
	matchesSearch,
	missingBlockers,
	PLANNING_QUICKS,
	type PlanningQuick,
	planningPools,
	waitingOn,
} from "../../lib/sprint-planning";
import { cn, extractTextFromHtml } from "../../lib/utils";
import { openSmartEstimation } from "../../stores/smart-estimation-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { useSelectedServerProject } from "./ServerBoardNotice";
import { SprintCapacity } from "./SprintCapacity";
import { useSprintFailure } from "./SprintDialogs";
import { PlanningPane } from "./SprintPlanningPane";
import { offeredPoints, ProposalFooter, ProposalHeader, ProposalRows, useSprintProposal } from "./SprintProposalPanel";

const NO_IDS: ReadonlySet<string> = new Set();

/** The last move, to undo it: the cards and the sprint they came from (null: the backlog). */
interface LastMove {
	ids: readonly string[];
	from: string | null;
	to: string | null;
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
	const start = useSprintStore((s) => s.start);
	const tasks = useTaskStore((s) => s.tasks);
	const serverProject = useSelectedServerProject();
	const canEdit = !serverProject || (serverProject.remote?.role ?? "viewer") !== "viewer";
	const failed = useSprintFailure();
	const [search, setSearch] = useState("");
	const [quick, setQuick] = useState<PlanningQuick>("all");
	const [fromBacklog, setFromBacklog] = useState<ReadonlySet<string>>(NO_IDS);
	const [fromSprint, setFromSprint] = useState<ReadonlySet<string>>(NO_IDS);
	const [busy, setBusy] = useState(false);
	const [lastMove, setLastMove] = useState<LastMove | null>(null);
	const pools = useMemo(() => planningPools(tasks, sprint.id), [tasks, sprint.id]);

	const { offered, phase } = useSprintProposal(sprint);
	// A card the proposal offers shows on the sprint side, in dashed violet, not in the backlog too.
	const offeredSet = useMemo(() => new Set(offered), [offered]);
	const searched = pools.backlog.filter((task) => !offeredSet.has(task.id) && matchesSearch(task, search));
	const backlog = searched.filter((task) => matchesQuick(task, quick));
	const backlogPoints = backlog.reduce((sum, task) => sum + taskPoints(task), 0);
	const missing = useMemo(() => missingBlockers(pools.sprint, tasks), [pools.sprint, tasks]);
	const otherActive = sprint.state === "planned" && !!activeSprint(sprints);
	const proposed = useMemo(() => offeredPoints(offered, tasks, sprint.id), [offered, tasks, sprint.id]);
	const proposing = canEdit && (phase === "thinking" || phase === "ready");

	const move = useCallback(
		async (ids: readonly string[], to: string | null, remember = true) => {
			if (ids.length === 0 || busy || !canEdit) return false;
			setBusy(true);
			const outcome = await assign(ids, to);
			setBusy(false);
			const moved = new Set(ids);
			const keep = (set: ReadonlySet<string>) => new Set([...set].filter((id) => !moved.has(id)));
			setFromBacklog(keep);
			setFromSprint(keep);
			if (!failed(outcome)) return false;
			setLastMove(remember ? { ids, from: to ? null : sprint.id, to } : null);
			return true;
		},
		[assign, busy, canEdit, failed, sprint.id],
	);

	const undo = () => {
		if (lastMove) void move(lastMove.ids, lastMove.from, false);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		const target = event.target as HTMLElement;
		if (target.closest("input, textarea")) return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && lastMove) {
			event.preventDefault();
			undo();
		}
	};

	const chips = (task: Task) => {
		const from = carriedFromSprint(task, sprints);
		const waits = task.status === "done" ? [] : waitingOn(task, tasks);
		if (!from && waits.length === 0) return null;
		return (
			<>
				{from && (
					<span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-1.5 text-2xs font-medium text-info">
						<CornerDownRight className="h-3 w-3" aria-hidden="true" />
						{t("tasks:kanban.sprints.planning.carriedFrom", { name: from.name })}
					</span>
				)}
				{waits.length > 0 && (
					<span
						className="inline-flex min-w-0 items-center gap-1 rounded-full bg-warning/10 px-1.5 text-2xs font-medium text-warning"
						title={waits.map((blocker) => blocker.title).join("\n")}
					>
						<Link2 className="h-3 w-3 shrink-0" aria-hidden="true" />
						<span className="truncate">
							{t("tasks:kanban.sprints.planning.waitingOn", { count: waits.length, title: waits[0].title })}
						</span>
					</span>
				)}
			</>
		);
	};
	const estimate = (task: Task) =>
		canEdit ? (
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-6 px-2 text-2xs"
				onClick={() => openSmartEstimation(extractTextFromHtml(task.description ?? "") || task.title, task.id)}
				title={t("tasks:kanban.sprints.planning.estimateHint")}
			>
				{t("tasks:kanban.sprints.planning.estimate")}
			</Button>
		) : undefined;

	const quickCount = (value: PlanningQuick) => searched.filter((task) => matchesQuick(task, value)).length;

	return (
		<Dialog open onOpenChange={(open) => !open && closePlanning()}>
			<DialogContent className="sm:max-w-5xl" data-testid="sprint-planning" onKeyDown={onKeyDown}>
				<DialogHeader>
					<DialogTitle>{t("tasks:kanban.sprints.planning.title", { name: sprint.name })}</DialogTitle>
					<DialogDescription>
						{sprint.goal
							? t("tasks:kanban.sprints.planning.goal", { goal: sprint.goal })
							: t("tasks:kanban.sprints.planning.hint")}
					</DialogDescription>
				</DialogHeader>
				<SprintPicker current={sprint} onPick={openPlanning} />
				<SprintCapacity sprint={sprint} points={pools.points} proposed={proposed} canEdit={canEdit} />
				<div className="grid max-h-[56vh] min-h-0 gap-3 md:h-[56vh] md:grid-cols-2 md:grid-rows-[minmax(0,1fr)]">
					<PlanningPane
						testId="sprint-planning-backlog"
						title={t("tasks:kanban.sprints.backlog")}
						summary={t("tasks:kanban.sprints.planning.summary", { count: backlog.length, points: backlogPoints })}
						empty={
							search.trim() || quick !== "all"
								? t("tasks:kanban.sprints.planning.noMatch")
								: t("tasks:kanban.sprints.planning.backlogEmpty")
						}
						tasks={backlog}
						selected={fromBacklog}
						onToggle={(id) => setFromBacklog((set) => toggled(set, id))}
						onToggleAll={(checked) => setFromBacklog(checked ? new Set(backlog.map((task) => task.id)) : NO_IDS)}
						onMove={(ids) => void move(ids, sprint.id)}
						onReceive={(ids) => void move(ids, null)}
						moveLabel={t("tasks:kanban.sprints.planning.addOne")}
						direction="right"
						busy={busy}
						canEdit={canEdit}
						renderUnestimated={estimate}
						header={
							<div className="grid gap-1.5 border-b border-border/50 px-2 py-1.5">
								<div className="relative">
									<Search
										className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
										aria-hidden="true"
									/>
									<Input
										value={search}
										onChange={(event) => setSearch(event.target.value)}
										placeholder={t("tasks:kanban.sprints.planning.search")}
										aria-label={t("tasks:kanban.sprints.planning.search")}
										className="h-8 pl-7 text-sm"
									/>
								</div>
								<fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0" aria-label={t("tasks:kanban.sprints.planning.quickLabel")}>
									{PLANNING_QUICKS.map((value) => (
										<button
											key={value}
											type="button"
											aria-pressed={quick === value}
											onClick={() => setQuick(value)}
											className={cn(
												"rounded-full border px-2 py-0.5 text-2xs transition-colors",
												quick === value
													? "border-primary bg-primary/10 font-semibold text-foreground"
													: "border-border/60 text-muted-foreground hover:text-foreground",
											)}
										>
											{t(`tasks:kanban.sprints.planning.quick.${value}`, { count: quickCount(value) })}
										</button>
									))}
								</fieldset>
							</div>
						}
						footer={
							canEdit ? (
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
							) : null
						}
					/>
					<PlanningPane
						testId="sprint-planning-sprint"
						title={sprint.name}
						summary={t("tasks:kanban.sprints.planning.summary", { count: pools.sprint.length, points: pools.points })}
						empty={t("tasks:kanban.sprints.planning.sprintEmpty")}
						tasks={pools.sprint}
						selected={fromSprint}
						onToggle={(id) => setFromSprint((set) => toggled(set, id))}
						onToggleAll={(checked) => setFromSprint(checked ? new Set(pools.sprint.map((task) => task.id)) : NO_IDS)}
						onMove={(ids) => void move(ids, null)}
						onReceive={(ids) => void move(ids, sprint.id)}
						moveLabel={t("tasks:kanban.sprints.planning.removeOne")}
						direction="left"
						busy={busy}
						canEdit={canEdit}
						renderChips={chips}
						renderUnestimated={estimate}
						header={<ProposalHeader sprint={sprint} canEdit={canEdit} />}
						after={proposing ? <ProposalRows sprint={sprint} tasks={tasks} busy={busy} /> : undefined}
						footer={
							canEdit ? (
								<div className="grid gap-2">
									<ProposalFooter sprint={sprint} busy={busy} onAccept={(ids) => move(ids, sprint.id)} />
									{missing.length > 0 && (
										<div
											data-testid="sprint-planning-missing"
											className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning"
										>
											<Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
											<span className="min-w-0 flex-1">
												{t("tasks:kanban.sprints.planning.missing", { count: missing.length })}
											</span>
											<Button
												type="button"
												size="sm"
												variant="outline"
												className="h-6 px-2 text-2xs"
												disabled={busy}
												onClick={() => void move(missing.map((task) => task.id), sprint.id)}
											>
												{t("tasks:kanban.sprints.planning.addMissing", { count: missing.length })}
											</Button>
										</div>
									)}
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
								</div>
							) : null
						}
					/>
				</div>
				<DialogFooter className="items-center gap-2 sm:justify-between">
					<output className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
						{lastMove && (
							<>
								<span>
									{lastMove.to
										? t("tasks:kanban.sprints.planning.added", { count: lastMove.ids.length })
										: t("tasks:kanban.sprints.planning.removed", { count: lastMove.ids.length })}
								</span>
								<Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2" onClick={undo} disabled={busy}>
									<Undo2 className="h-3.5 w-3.5" />
									{t("tasks:kanban.sprints.planning.undo")}
								</Button>
							</>
						)}
					</output>
					<div className="flex items-center gap-2">
						<Button type="button" variant="ghost" onClick={closePlanning}>
							{t("common:buttons.close")}
						</Button>
						{canEdit && sprint.state === "planned" && (
							<Button
								type="button"
								className="gap-2"
								disabled={otherActive || busy}
								title={otherActive ? t("tasks:kanban.sprints.oneActive") : undefined}
								onClick={async () => {
									if (sprintProgress(tasks, sprint.id).cards === 0) return;
									failed(await start(sprint.id));
								}}
							>
								<Play className="h-4 w-4" />
								{t("tasks:kanban.sprints.planning.start")}
							</Button>
						)}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
