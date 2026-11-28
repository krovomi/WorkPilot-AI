import { AlertTriangle, Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type InterruptedLaunchPolicy,
	type InterruptedTask,
	INTERRUPTED_LAUNCH_POLICIES,
	normalizeInterruptedLaunchPolicy,
} from "../../../shared/types/interrupted-tasks";
import { toast } from "../../hooks/use-toast";
import { formatAppDateTime } from "../../lib/date-format";
import { cn } from "../../lib/utils";
import { useInterruptedTasksStore } from "../../stores/interrupted-tasks-store";
import { useProjectStore } from "../../stores/project-store";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

const K = "tasks:interrupted";

/** The Kanban's own default for « En cours » (KanbanBoard). */
const DEFAULT_MAX_PARALLEL = 3;

const STEPS = ["spec", "planning", "coding", "qa"] as const;

function stepOf(task: InterruptedTask): (typeof STEPS)[number] {
	return task.phase === "qa_review" || task.phase === "qa_fixing" ? "qa" : task.phase;
}

/** « il y a 14 min » under an hour, … , else the date in the app's language. */
function useAgo() {
	const { t } = useTranslation(["tasks"]);
	return (iso: string | null): string | null => {
		if (!iso) return null;
		const at = new Date(iso);
		const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
		if (Number.isNaN(minutes)) return null;
		if (minutes < 1) return t(`${K}.ago.now`);
		if (minutes < 60) return t(`${K}.ago.minutes`, { count: minutes });
		if (minutes < 24 * 60) return t(`${K}.ago.hours`, { count: Math.floor(minutes / 60) });
		return formatAppDateTime(at);
	};
}

function PhaseSteps({ task }: { readonly task: InterruptedTask }) {
	const { t } = useTranslation(["tasks"]);
	const current = STEPS.indexOf(stepOf(task));
	return (
		<div className="flex flex-wrap items-center gap-1 text-xs">
			{STEPS.map((step, index) => (
				<span
					key={step}
					className={cn(
						"rounded-md border px-1.5 py-px",
						index < current && "border-transparent bg-success/10 text-success",
						index === current && "border-primary/50 bg-primary/10 font-semibold text-foreground",
						index > current && "border-border text-muted-foreground",
					)}
				>
					{step === "coding" && index === current && task.subtasksTotal > 0
						? t(`${K}.steps.codingCount`, { done: task.subtasksDone, total: task.subtasksTotal })
						: t(`${K}.steps.${step}`)}
				</span>
			))}
		</div>
	);
}

function TaskRow({
	task,
	checked,
	onToggle,
}: {
	readonly task: InterruptedTask;
	readonly checked: boolean;
	readonly onToggle: () => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const ago = useAgo()(task.interruptedAt);
	const engine = [task.provider, task.model].filter(Boolean).join(" · ");
	const where =
		task.phase === "coding" && task.nextSubtask
			? t(`${K}.where.subtask`, { subtask: task.nextSubtask })
			: t(`${K}.where.${task.phase}`);
	const id = `interrupted-${task.taskId}`;
	return (
		<label
			htmlFor={id}
			data-testid="interrupted-row"
			className={cn(
				"grid cursor-pointer grid-cols-[auto_1fr] gap-3 rounded-lg border p-3 transition-colors",
				checked ? "border-primary/60 bg-primary/5" : "border-border hover:border-primary/40",
			)}
		>
			<Checkbox id={id} checked={checked} onCheckedChange={onToggle} className="mt-0.5" />
			<div className="grid min-w-0 gap-1.5">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<span className="font-medium">{task.title}</span>
					<span className="rounded-full border border-border px-2 text-xs text-muted-foreground">
						{task.projectName}
					</span>
					{engine && (
						<span className="rounded-full border border-border px-2 text-xs text-muted-foreground">
							{engine}
						</span>
					)}
					<span
						className={cn(
							"rounded-full border px-2 text-xs",
							task.origin === "crash" || task.origin === "server_restart"
								? "border-warning/40 bg-warning/10 text-warning"
								: "border-border text-muted-foreground",
						)}
					>
						{ago
							? t(`${K}.origin.${task.origin}WithTime`, { ago })
							: t(`${K}.origin.${task.origin}`)}
					</span>
				</div>
				<PhaseSteps task={task} />
				<p className="text-xs text-muted-foreground">
					{task.origin === "stopped_by_you" ? t(`${K}.stoppedByYou`, { where }) : where}
				</p>
				{task.startedByName && (
					<p className="text-xs text-muted-foreground">
						{t(`${K}.startedBy`, { name: task.startedByName })}
					</p>
				)}
				{task.blocker && (
					<p className="flex flex-wrap items-center gap-2 text-xs text-destructive">
						<AlertTriangle className="h-3.5 w-3.5" />
						{t(`${K}.blocker.${task.blocker}`)}
						{task.blocker === "claude_auth" && (
							<button
								type="button"
								className="font-semibold text-primary hover:underline"
								onClick={(event) => {
									event.preventDefault();
									globalThis.dispatchEvent(
										new CustomEvent("open-app-settings", { detail: "accounts" }),
									);
								}}
							>
								{t(`${K}.blocker.reconnect`)}
							</button>
						)}
					</p>
				)}
			</div>
		</label>
	);
}

/** One line per project whose « En cours » cannot take every ticked build at once. */
function useSlotLines(tasks: InterruptedTask[], selected: Set<string>): string[] {
	const { t } = useTranslation(["tasks"]);
	const projects = useProjectStore((s) => s.projects);
	return useMemo(() => {
		const perProject = new Map<string, { name: string; count: number }>();
		for (const task of tasks) {
			// A server card waits behind the server's own limit, not this project's.
			if (!selected.has(task.taskId) || stepOf(task) === "qa" || task.onServer) continue;
			const entry = perProject.get(task.projectId) ?? { name: task.projectName, count: 0 };
			entry.count += 1;
			perProject.set(task.projectId, entry);
		}
		const lines: string[] = [];
		for (const [projectId, { name, count }] of perProject) {
			const limit =
				projects.find((p) => p.id === projectId)?.settings?.maxParallelTasks ??
				DEFAULT_MAX_PARALLEL;
			if (count > limit) {
				lines.push(t(`${K}.slots`, { project: name, limit, count: count - limit }));
			}
		}
		return lines;
	}, [tasks, selected, projects, t]);
}

function OfferDialog({ tasks }: { readonly tasks: InterruptedTask[] }) {
	const { t } = useTranslation(["tasks"]);
	const savedPolicy = useSettingsStore((s) => s.settings.interruptedTasksOnLaunch);
	const [policy, setPolicy] = useState<InterruptedLaunchPolicy>(() =>
		normalizeInterruptedLaunchPolicy(savedPolicy),
	);
	const [selected, setSelected] = useState(
		() => new Set(tasks.filter((task) => task.selectedByDefault).map((task) => task.taskId)),
	);
	const [busy, setBusy] = useState(false);
	const slotLines = useSlotLines(tasks, selected);
	const allSelected = selected.size === tasks.length;

	const toggle = (taskId: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(taskId)) next.delete(taskId);
			else next.add(taskId);
			return next;
		});

	const answer = async (resumeIds: string[]) => {
		if (busy) return;
		setBusy(true);
		try {
			if (policy !== normalizeInterruptedLaunchPolicy(savedPolicy)) {
				await saveSettings({ interruptedTasksOnLaunch: policy });
			}
			const result = await globalThis.electronAPI.resolveInterruptedTasks(resumeIds);
			if (resumeIds.length > 0) {
				toast({
					title: t(`${K}.toast.resumed`, { count: result.resumed.length }),
					description: [
						result.waiting.length > 0 ? t(`${K}.toast.waiting`, { count: result.waiting.length }) : "",
						result.failed.length > 0 ? t(`${K}.toast.failed`, { count: result.failed.length }) : "",
					]
						.filter(Boolean)
						.join(" "),
					variant: result.failed.length > 0 ? "destructive" : undefined,
				});
			}
		} finally {
			useInterruptedTasksStore.getState().close();
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) void answer([]);
			}}
		>
			<DialogContent className="max-w-2xl" data-testid="interrupted-tasks-dialog">
				<DialogTitle>{t(`${K}.title`, { count: tasks.length })}</DialogTitle>
				<DialogDescription>
					{t(tasks.some((task) => task.onServer) ? `${K}.descriptionServer` : `${K}.description`)}
				</DialogDescription>
				<div className="flex items-center justify-between px-0.5 text-xs text-muted-foreground">
					<span>{t(`${K}.selectedCount`, { count: selected.size, total: tasks.length })}</span>
					<button
						type="button"
						className="font-semibold text-primary hover:underline"
						onClick={() =>
							setSelected(allSelected ? new Set() : new Set(tasks.map((task) => task.taskId)))
						}
					>
						{allSelected ? t(`${K}.selectNone`) : t(`${K}.selectAll`)}
					</button>
				</div>
				<div className="grid max-h-[50vh] gap-2 overflow-y-auto pr-1">
					{tasks.map((task) => (
						<TaskRow
							key={task.taskId}
							task={task}
							checked={selected.has(task.taskId)}
							onToggle={() => toggle(task.taskId)}
						/>
					))}
				</div>
				{slotLines.map((line) => (
					<p key={line} className="rounded-md bg-info/10 px-3 py-2 text-xs text-info">
						{line}
					</p>
				))}
				<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
					<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span>{t(`${K}.nextTime`)}</span>
						<div className="inline-flex overflow-hidden rounded-md border border-border">
							{INTERRUPTED_LAUNCH_POLICIES.map((value) => (
								<button
									key={value}
									type="button"
									aria-pressed={policy === value}
									data-testid={`interrupted-policy-${value}`}
									onClick={() => setPolicy(value)}
									className={cn(
										"border-border px-2.5 py-1 not-first:border-l",
										policy === value ? "bg-primary/10 font-semibold text-foreground" : "hover:bg-accent/50",
									)}
								>
									{t(`${K}.policy.${value}`)}
								</button>
							))}
						</div>
					</div>
					<div className="ml-auto flex gap-2">
						<Button variant="outline" disabled={busy} onClick={() => void answer([])}>
							{t(`${K}.later`)}
						</Button>
						<Button
							autoFocus
							disabled={busy || selected.size === 0}
							onClick={() => void answer([...selected])}
							data-testid="interrupted-resume"
						>
							{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
							{t(`${K}.resume`, { count: selected.size })}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * At launch: the Kanban builds the last exit interrupted, ticked by default
 * when the app interrupted them, unticked when the person stopped them
 * (docs/architecture/pause-resume.md). With « Tout reprendre », only a toast
 * says what restarted.
 */
export function InterruptedTasksDialog() {
	const { t } = useTranslation(["tasks"]);
	const offer = useInterruptedTasksStore((s) => s.offer);
	const autoResumed = useInterruptedTasksStore((s) => s.autoResumed);

	useEffect(() => {
		if (!autoResumed) return;
		if (autoResumed.length > 0) {
			toast({
				title: t(`${K}.toast.autoResumed`, { count: autoResumed.length }),
				description: autoResumed.map((task) => task.title).join(", "),
			});
		}
		useInterruptedTasksStore.getState().clearAutoResumed();
	}, [autoResumed, t]);

	if (!offer || offer.length === 0) return null;
	return <OfferDialog key={offer.map((task) => task.taskId).join(",")} tasks={offer} />;
}
