/**
 * « Proposer le sprint » on the sprint side of the planning view.
 *
 * - {@link ProposalHeader}: the button, then the settings (goal, capacity,
 *   intention, what is sent to the provider), the wait, and once the answer
 *   is in, its title, why, the variants to ask again and a suggested goal.
 * - {@link ProposalRows}: the cards offered, in dashed violet with their
 *   reason, the capacity line and the best cards below it (each can be put
 *   in), or the places being filled while the model works.
 * - {@link ProposalFooter}: « Add N cards » and « Dismiss ».
 *
 * Nothing moves before « Add »: the cards then go in through the planning
 * view's own move, one move the view's « Undo » takes back.
 *
 * Design: docs/architecture/sprint-proposal.md.
 */
import {
	AlertTriangle,
	ArrowUpRight,
	Bug,
	ChevronDown,
	Clock3,
	Flag,
	Link2,
	Loader2,
	Minus,
	Plus,
	ShieldCheck,
	Sparkles,
	Target,
	X,
} from "lucide-react";
import type { TFunction } from "i18next";
import { type ComponentType, type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Sprint, SprintPickReason, SprintProposal, SprintProposalPick, Task } from "../../../shared/types";
import { SPRINT_PROPOSAL_LIMITS, SPRINT_PROPOSAL_VARIANTS } from "../../../shared/types/sprint-proposal";
import { MAX_CAPACITY, sprintCapacity, taskPoints } from "../../../shared/utils/sprints";
import { cn } from "../../lib/utils";
import { offeredIds, useSprintProposalStore } from "../../stores/sprint-proposal-store";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSprintFailure } from "./SprintDialogs";

const REASON_ICONS: Record<SprintPickReason, ComponentType<{ className?: string }>> = {
	dependency: Link2,
	urgent: AlertTriangle,
	bug: Bug,
	unblocks: ArrowUpRight,
	goal: Target,
	high: Flag,
	oldest: Clock3,
	fits: Sparkles,
};
const STEPS = ["gather", "compose", "check"] as const;
/** The places shown while the model composes. */
const SKELETONS = ["first", "second", "third"] as const;

/** The proposal shown for this sprint, if the store holds one for it in this project. */
export function useSprintProposal(sprint: Sprint) {
	const projectId = useSprintStore((s) => s.projectId);
	const state = useSprintProposalStore(
		useShallow((s) => ({
			sprintId: s.sprintId,
			projectId: s.projectId,
			phase: s.phase,
			ask: s.ask,
			proposal: s.proposal,
			removed: s.removed,
			added: s.added,
			error: s.error,
			propose: s.propose,
			dismiss: s.dismiss,
			toggleRemoved: s.toggleRemoved,
			toggleAdded: s.toggleAdded,
		})),
	);
	const mine = state.sprintId === sprint.id && state.projectId === projectId;
	const offered = useMemo(
		() => (mine ? offeredIds(state.proposal, state.removed, state.added) : []),
		[mine, state.proposal, state.removed, state.added],
	);
	return { ...state, phase: mine ? state.phase : "idle", mine, offered };
}

/** The points of the cards offered that are not in the sprint yet, for the gauge. */
export function offeredPoints(ids: readonly string[], tasks: readonly Task[], sprintId: string): number {
	const wanted = new Set(ids);
	return tasks.reduce(
		(sum, task) => sum + (wanted.has(task.id) && task.metadata?.sprintId !== sprintId ? taskPoints(task) : 0),
		0,
	);
}

function Settings({ sprint }: { sprint: Sprint }) {
	const { t } = useTranslation(["tasks", "common"]);
	const sprints = useSprintStore((s) => s.sprints);
	const ask = useSprintProposalStore((s) => s.ask);
	const propose = useSprintProposalStore((s) => s.propose);
	const dismiss = useSprintProposalStore((s) => s.dismiss);
	const base = sprintCapacity(sprint, sprints).points;
	const [goal, setGoal] = useState(ask.goal || sprint.goal || "");
	const [capacity, setCapacity] = useState(ask.capacity ?? base);
	const [variant, setVariant] = useState(ask.variant);
	const goalId = useId();
	const capacityId = useId();
	const low = Math.max(1, Math.round(base / 2));
	const high = Math.min(MAX_CAPACITY, Math.max(low + 1, Math.round(base * 1.5)));

	return (
		<form
			data-testid="sprint-proposal-settings"
			className="grid gap-2.5 border-b border-border/50 bg-violet-500/5 px-3 py-2.5"
			onSubmit={(event) => {
				event.preventDefault();
				void propose(sprint.id, {
					variant,
					goal: goal.trim() === (sprint.goal ?? "").trim() ? "" : goal,
					capacity: capacity === base ? null : capacity,
				});
			}}
		>
			<div className="flex items-center gap-2 text-sm font-semibold">
				<Sparkles className="h-4 w-4 text-violet-500" aria-hidden="true" />
				<span className="flex-1">{t("tasks:kanban.sprints.proposal.settingsTitle")}</span>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-6 w-6"
					onClick={dismiss}
					aria-label={t("common:buttons.close")}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			</div>
			<div className="grid gap-1 text-xs">
				<label htmlFor={goalId} className="font-medium text-muted-foreground">
					{t("tasks:kanban.sprints.proposal.goalLabel")}
				</label>
				<Input
					id={goalId}
					value={goal}
					maxLength={SPRINT_PROPOSAL_LIMITS.goal}
					onChange={(event) => setGoal(event.target.value)}
					placeholder={t("tasks:kanban.sprints.proposal.goalPlaceholder")}
					className="h-8 text-sm"
				/>
			</div>
			<div className="grid gap-1 text-xs">
				<span className="flex items-center justify-between font-medium text-muted-foreground">
					<label htmlFor={capacityId}>{t("tasks:kanban.sprints.proposal.capacityLabel", { count: capacity })}</label>
					<span className="tabular-nums">
						{t("tasks:kanban.sprints.capacity.share", { percent: Math.round((capacity / base) * 100) })}
					</span>
				</span>
				<input
					id={capacityId}
					type="range"
					min={low}
					max={high}
					step={1}
					value={capacity}
					onChange={(event) => setCapacity(Number(event.target.value))}
					className="w-full accent-violet-500"
				/>
			</div>
			<fieldset className="m-0 grid gap-1 border-0 p-0 text-xs">
				<legend className="mb-1 font-medium text-muted-foreground">{t("tasks:kanban.sprints.proposal.variantLabel")}</legend>
				<div className="flex flex-wrap gap-1">
					{SPRINT_PROPOSAL_VARIANTS.map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={variant === value}
							onClick={() => setVariant(value)}
							className={cn(
								"rounded-full border px-2 py-0.5 text-2xs transition-colors",
								variant === value
									? "border-violet-500 bg-violet-500/10 font-semibold text-foreground"
									: "border-border/60 text-muted-foreground hover:text-foreground",
							)}
						>
							{t(`tasks:kanban.sprints.proposal.variants.${value}`)}
						</button>
					))}
				</div>
			</fieldset>
			<p className="flex gap-1.5 text-2xs text-muted-foreground">
				<ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				{t("tasks:kanban.sprints.proposal.privacy")}
			</p>
			<Button type="submit" size="sm" className="gap-2 bg-violet-600 text-white hover:bg-violet-600/90">
				<Sparkles className="h-4 w-4" />
				{t("tasks:kanban.sprints.proposal.run")}
			</Button>
		</form>
	);
}

function Thinking() {
	const { t } = useTranslation(["tasks"]);
	return (
		<output
			data-testid="sprint-proposal-thinking"
			className="grid gap-1.5 border-b border-border/50 bg-violet-500/5 px-3 py-2.5 text-xs"
		>
			<span className="flex items-center gap-2 font-semibold text-sm">
				<Loader2 className="h-4 w-4 animate-spin text-violet-500" aria-hidden="true" />
				{t("tasks:kanban.sprints.proposal.thinking")}
			</span>
			<ol className="m-0 grid list-none gap-0.5 p-0 text-muted-foreground">
				{STEPS.map((step) => (
					<li key={step}>{t(`tasks:kanban.sprints.proposal.steps.${step}`)}</li>
				))}
			</ol>
		</output>
	);
}

function Ready({ sprint, canEdit }: { sprint: Sprint; canEdit: boolean }) {
	const { t } = useTranslation(["tasks"]);
	const tasks = useTaskStore((s) => s.tasks);
	const save = useSprintStore((s) => s.save);
	const failed = useSprintFailure();
	const { proposal, offered, ask, propose, dismiss } = useSprintProposal(sprint);
	const [why, setWhy] = useState(false);
	const [usingGoal, setUsingGoal] = useState(false);
	// A proposal is always held once ready.
	const shown = proposal as SprintProposal;
	const points = offeredPoints(offered, tasks, sprint.id);

	const useGoal = async () => {
		setUsingGoal(true);
		failed(
			await save({
				id: sprint.id,
				name: sprint.name,
				goal: shown.goal,
				startDate: sprint.startDate,
				endDate: sprint.endDate,
			}),
		);
		setUsingGoal(false);
	};

	return (
		<div data-testid="sprint-proposal-ready" className="grid gap-2 border-b border-border/50 bg-violet-500/5 px-3 py-2.5 text-xs">
			<div className="flex items-center gap-2">
				<Sparkles className="h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
				<span className="flex-1 text-sm font-semibold">
					{t("tasks:kanban.sprints.proposal.title", { count: offered.length, points })}
				</span>
				<span className="rounded bg-violet-500/10 px-1.5 text-2xs font-medium text-violet-700 dark:text-violet-300">
					{shown.mode === "ai" ? t("tasks:kanban.sprints.proposal.byAi") : t("tasks:kanban.sprints.proposal.byRules")}
				</span>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-6 w-6"
					onClick={dismiss}
					aria-label={t("tasks:kanban.sprints.proposal.dismiss")}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			</div>
			{shown.summary && (
				<div>
					<button
						type="button"
						aria-expanded={why}
						onClick={() => setWhy((open) => !open)}
						className="inline-flex items-center gap-1 font-medium text-violet-700 dark:text-violet-300"
					>
						{t("tasks:kanban.sprints.proposal.why")}
						<ChevronDown className={cn("h-3.5 w-3.5 transition-transform", why && "rotate-180")} aria-hidden="true" />
					</button>
					{why && <p className="mt-1 text-muted-foreground">{shown.summary}</p>}
				</div>
			)}
			{shown.goal && !sprint.goal && (
				<div
					data-testid="sprint-proposal-goal"
					className="flex flex-wrap items-center gap-2 rounded-md border border-violet-500/30 px-2 py-1.5"
				>
					<Target className="h-3.5 w-3.5 shrink-0 text-violet-500" aria-hidden="true" />
					<span className="min-w-0 flex-1">{t("tasks:kanban.sprints.proposal.suggestedGoal", { goal: shown.goal })}</span>
					{canEdit && (
						<Button type="button" size="sm" variant="outline" className="h-6 px-2 text-2xs" disabled={usingGoal} onClick={useGoal}>
							{t("tasks:kanban.sprints.proposal.useGoal")}
						</Button>
					)}
				</div>
			)}
			{shown.picks.length === 0 && <p className="text-muted-foreground">{t("tasks:kanban.sprints.proposal.nothing")}</p>}
			{shown.unestimated.length > 0 && (
				<p className="text-muted-foreground">
					{t("tasks:kanban.sprints.proposal.unestimated", { count: shown.unestimated.length })}
				</p>
			)}
			{shown.blocked.length > 0 && (
				<p className="text-warning">{t("tasks:kanban.sprints.proposal.blocked", { count: shown.blocked.length })}</p>
			)}
			<fieldset className="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
				<legend className="sr-only">{t("tasks:kanban.sprints.proposal.rerun")}</legend>
				<span className="mr-1 text-muted-foreground">{t("tasks:kanban.sprints.proposal.rerun")}</span>
				{SPRINT_PROPOSAL_VARIANTS.filter((value) => value !== shown.variant).map((value) => (
					<button
						key={value}
						type="button"
						onClick={() => void propose(sprint.id, { ...ask, variant: value })}
						className="rounded-full border border-border/60 px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:border-violet-500 hover:text-foreground"
					>
						{t(`tasks:kanban.sprints.proposal.variants.${value}`)}
					</button>
				))}
			</fieldset>
		</div>
	);
}

function Failed({ sprint }: { sprint: Sprint }) {
	const { t } = useTranslation(["tasks"]);
	const { error, ask, propose, dismiss } = useSprintProposal(sprint);
	return (
		<div
			data-testid="sprint-proposal-failed"
			className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-destructive/5 px-3 py-2 text-xs text-destructive"
		>
			<AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 flex-1">{t("tasks:kanban.sprints.proposal.failed", { error })}</span>
			<Button type="button" size="sm" variant="outline" className="h-6 px-2 text-2xs" onClick={() => void propose(sprint.id, ask)}>
				{t("tasks:kanban.sprints.proposal.retry")}
			</Button>
			<Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={dismiss}>
				{t("tasks:kanban.sprints.proposal.dismiss")}
			</Button>
		</div>
	);
}

/** Above the sprint's cards: the button, the settings, the wait or the proposal's toolbar. */
export function ProposalHeader({ sprint, canEdit }: { sprint: Sprint; canEdit: boolean }) {
	const { t } = useTranslation(["tasks"]);
	const { phase } = useSprintProposal(sprint);
	const openSettings = useSprintProposalStore((s) => s.openSettings);
	if (!canEdit) return null;
	if (phase === "settings") return <Settings sprint={sprint} />;
	if (phase === "thinking") return <Thinking />;
	if (phase === "ready") return <Ready sprint={sprint} canEdit={canEdit} />;
	if (phase === "failed") return <Failed sprint={sprint} />;
	return (
		<div className="border-b border-border/50 px-2 py-1.5">
			<Button
				type="button"
				size="sm"
				variant="outline"
				data-testid="sprint-proposal-open"
				className="w-full gap-2 border-dashed border-violet-500/50 text-violet-700 dark:text-violet-300 hover:bg-violet-500/10"
				onClick={() => openSettings(sprint.id)}
			>
				<Sparkles className="h-4 w-4" />
				{t("tasks:kanban.sprints.proposal.open")}
			</Button>
		</div>
	);
}

function reasonLabel(pick: SprintProposalPick, titleOf: (id: string) => string, t: TFunction) {
	if (pick.note) return pick.note;
	if (pick.reason === "dependency") {
		return t("tasks:kanban.sprints.proposal.reasons.dependency", { title: titleOf(pick.dependencyOf ?? "") });
	}
	if (pick.reason === "unblocks") return t("tasks:kanban.sprints.proposal.reasons.unblocks", { count: pick.unblocks ?? 1 });
	return t(`tasks:kanban.sprints.proposal.reasons.${pick.reason}`);
}

function Row({
	task,
	points,
	icon: Icon,
	reason,
	kind,
	action,
}: {
	task: Task;
	points: number;
	icon: ComponentType<{ className?: string }>;
	reason: ReactNode;
	kind: "offered" | "out" | "below";
	action: ReactNode;
}) {
	const { t } = useTranslation(["tasks"]);
	return (
		<li
			data-proposed={kind}
			data-task={task.id}
			className={cn(
				"flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm",
				kind === "offered" && "border-dashed border-violet-500/60 bg-violet-500/5",
				kind === "out" && "border-dashed border-border/60 opacity-60",
				kind === "below" && "border-border/40 bg-muted/20",
			)}
		>
			<div className="grid min-w-0 flex-1 gap-0.5">
				<span className={cn("min-w-0 truncate", kind === "out" && "line-through")}>{task.title}</span>
				<span className="flex min-w-0 items-center gap-1 text-2xs text-violet-700 dark:text-violet-300">
					<Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span className="truncate">{reason}</span>
				</span>
			</div>
			<span className="w-12 text-right text-2xs tabular-nums text-muted-foreground">
				{t("tasks:kanban.sprints.planning.points", { count: points })}
			</span>
			{action}
		</li>
	);
}

/** Inside the sprint's list, after its cards: the offered cards, the capacity line and what falls below it. */
export function ProposalRows({ sprint, tasks, busy }: { sprint: Sprint; tasks: readonly Task[]; busy: boolean }) {
	const { t } = useTranslation(["tasks"]);
	const { phase, proposal, removed, added, toggleRemoved, toggleAdded } = useSprintProposal(sprint);
	const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
	const titleOf = (id: string) => byId.get(id)?.title ?? "";

	if (phase === "thinking") {
		return (
			<>
				{SKELETONS.map((place) => (
					<li
						key={place}
						data-testid="sprint-proposal-skeleton"
						aria-hidden="true"
						className="h-10 animate-pulse rounded-lg border border-dashed border-violet-500/40 bg-violet-500/5"
					/>
				))}
			</>
		);
	}
	// Past the wait, the view shows these rows only once the proposal is ready, and it is then always held.
	const shown = proposal as SprintProposal;

	const toggle = (id: string, label: string, out: boolean) => (
		<Button
			type="button"
			size="icon"
			variant="ghost"
			className="h-6 w-6"
			onClick={() => toggleRemoved(id)}
			disabled={busy}
			aria-label={label}
			title={label}
		>
			{out ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
		</Button>
	);

	return (
		<>
			{shown.picks.map((pick) => {
				const task = byId.get(pick.taskId);
				if (!task || task.metadata?.sprintId === sprint.id) return null;
				const out = removed.has(pick.taskId);
				const label = out ? t("tasks:kanban.sprints.proposal.putBack") : t("tasks:kanban.sprints.proposal.remove");
				return (
					<Row
						key={pick.taskId}
						task={task}
						points={pick.points}
						icon={REASON_ICONS[pick.reason]}
						reason={reasonLabel(pick, titleOf, t)}
						kind={out ? "out" : "offered"}
						action={toggle(pick.taskId, label, out)}
					/>
				);
			})}
			{shown.below.length > 0 && (
				<li
					data-testid="sprint-proposal-line"
					className="flex items-center gap-2 px-1 py-1 text-2xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300"
				>
					<span className="h-px flex-1 border-t border-dashed border-violet-500/60" aria-hidden="true" />
					{t("tasks:kanban.sprints.proposal.line", { count: shown.capacity })}
					<span className="h-px flex-1 border-t border-dashed border-violet-500/60" aria-hidden="true" />
				</li>
			)}
			{shown.below.map((item) => {
				const task = byId.get(item.taskId);
				if (!task || task.metadata?.sprintId === sprint.id) return null;
				const isIn = added.includes(item.taskId);
				const label = isIn ? t("tasks:kanban.sprints.proposal.takeOut") : t("tasks:kanban.sprints.proposal.add");
				return (
					<Row
						key={item.taskId}
						task={task}
						points={item.points}
						icon={AlertTriangle}
						reason={t("tasks:kanban.sprints.proposal.with", { total: item.total, capacity: shown.capacity })}
						kind={isIn ? "offered" : "below"}
						action={
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="h-6 w-6"
								onClick={() => toggleAdded(item.taskId)}
								disabled={busy}
								aria-label={label}
								title={label}
							>
								{isIn ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
							</Button>
						}
					/>
				);
			})}
		</>
	);
}

/** « Add N cards » and « Dismiss », while a proposal is shown. */
export function ProposalFooter({
	sprint,
	busy,
	onAccept,
}: {
	sprint: Sprint;
	busy: boolean;
	/** Moves the cards into the sprint; true once they are in. */
	onAccept: (ids: readonly string[]) => Promise<boolean>;
}) {
	const { t } = useTranslation(["tasks"]);
	const { phase, offered, dismiss } = useSprintProposal(sprint);
	if (phase !== "ready") return null;
	return (
		<div className="flex gap-2">
			<Button
				type="button"
				size="sm"
				data-testid="sprint-proposal-accept"
				className="flex-1 gap-2 bg-violet-600 text-white hover:bg-violet-600/90"
				disabled={offered.length === 0 || busy}
				onClick={async () => {
					if (await onAccept(offered)) dismiss();
				}}
			>
				<Sparkles className="h-4 w-4" />
				{t("tasks:kanban.sprints.proposal.accept", { count: offered.length })}
			</Button>
			<Button type="button" size="sm" variant="ghost" onClick={dismiss} disabled={busy}>
				{t("tasks:kanban.sprints.proposal.dismiss")}
			</Button>
		</div>
	);
}
