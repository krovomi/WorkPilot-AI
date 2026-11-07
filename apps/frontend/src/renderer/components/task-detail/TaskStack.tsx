import { GitBranch, Layers } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import type { StackStatus } from "../../../shared/utils/task-stack";
import { indexTasksById, resolveBlockers } from "../../lib/kanban-dependencies";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";

interface TaskStackProps {
	readonly task: Task;
}

/** The codes the main process answers with; anything else is shown as unknown. */
const KNOWN_ERRORS = new Set([
	"same_task",
	"already_stacked",
	"not_blocker",
	"parent_done",
	"cycle",
	"child_started",
	"parent_no_worktree",
	"parent_no_commits",
	"metadata_unwritable",
	"task_not_found",
	"not_stacked",
	"running",
	"dirty",
	"no_recorded_commit",
	"no_base",
	"conflict",
	"pr_not_retargeted",
	"pr_url_unreadable",
]);

/**
 * Empiler une tâche sur un de ses prérequis (F6) : elle part de la branche
 * du prérequis au lieu du tronc, et « Mettre à jour » la garde dessus quand
 * le prérequis bouge ou une fois qu'il est fusionné. Git tourne dans le
 * main ; un conflit est listé, jamais résolu à la place de la personne.
 */
export function TaskStack({ task }: TaskStackProps) {
	const { t } = useTranslation("tasks");
	const tasks = useTaskStore((s) => s.tasks);
	const [status, setStatus] = useState<StackStatus | null>(null);
	const [hidden, setHidden] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [conflicts, setConflicts] = useState<string[]>([]);

	const byId = useMemo(() => indexTasksById(tasks), [tasks]);
	const pending = useMemo(() => resolveBlockers(task, byId).pending, [task, byId]);
	const parentSpec = task.metadata?.stackParent;
	const parentStatus = tasks.find((t) => t.specId === parentSpec)?.status;
	// What the status depends on: B's stack fields and A's column.
	const stamp = `${task.id}|${parentSpec ?? ""}|${task.metadata?.stackParentSha ?? ""}|${task.status}|${parentStatus ?? ""}`;
	const latest = useRef(stamp);

	const message = useCallback(
		(code: string | undefined) =>
			t(`stack.errors.${code && KNOWN_ERRORS.has(code) ? code : "unknown"}`),
		[t],
	);

	useEffect(() => {
		latest.current = stamp;
		void globalThis.electronAPI.getTaskStackStatus(task.id).then((result) => {
			// A newer read is on its way: drop this one.
			if (latest.current !== stamp) return;
			if (!result.success) {
				if (result.error === "local_only") setHidden(true);
				return;
			}
			setHidden(false);
			setStatus(result.data ?? { stacked: false });
		});
	}, [task.id, stamp]);

	function patchStore(patch: Record<string, unknown>) {
		const metadata: Record<string, unknown> = { ...task.metadata };
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete metadata[key];
			else metadata[key] = value;
		}
		useTaskStore.getState().updateTask(task.id, { metadata: metadata as Task["metadata"] });
	}

	async function stackOn(parent: Task) {
		setBusy(true);
		setError(null);
		setNote(null);
		setConflicts([]);
		const result = await globalThis.electronAPI.stackTaskOn(task.id, parent.id);
		setBusy(false);
		if (!result.success) {
			setError(message(result.error));
			return;
		}
		if (result.data) patchStore(result.data);
		setNote(t("stack.stackedNote", { title: parent.title }));
	}

	async function update() {
		setBusy(true);
		setError(null);
		setNote(null);
		setConflicts([]);
		const result = await globalThis.electronAPI.updateTaskStack(task.id);
		setBusy(false);
		if (!result.success) {
			setError(message(result.error));
			setConflicts(result.data?.conflicts ?? []);
			return;
		}
		const outcome = result.data?.outcome ?? "up_to_date";
		const parts = [t(`stack.outcome.${outcome}`)];
		if (result.data?.prNote) parts.push(message(result.data.prNote));
		setNote(parts.join(" "));
		if (result.data?.metadata) patchStore(result.data.metadata);
	}

	if (hidden || !status) return null;
	if (!status.stacked && pending.length === 0) return null;

	return (
		<div>
			<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
				<Layers className="h-3 w-3 text-info" />
				{t("stack.title")}
			</h3>

			{status.stacked ? (
				<div className="space-y-1.5">
					<p className="text-sm text-foreground/80 flex items-center gap-1.5">
						<GitBranch className="h-3 w-3 shrink-0" aria-hidden />
						{t("stack.stackedOn", {
							title: status.parentTitle ?? status.parentBranch,
							branch: status.parentBranch,
						})}
					</p>
					{status.parentMerged ? (
						<p className="text-xs text-muted-foreground">
							{t("stack.parentMerged", { base: status.nextBase })}
						</p>
					) : status.moved ? (
						<p className="text-xs text-warning">{t("stack.parentMoved")}</p>
					) : (
						<p className="text-xs text-muted-foreground">{t("stack.upToDate")}</p>
					)}
					{status.running && (
						<p className="text-xs text-muted-foreground">{t("stack.runningHint")}</p>
					)}
					{(status.parentMerged || status.moved) && (
						<Button size="sm" variant="outline" disabled={busy || status.running} onClick={update}>
							{status.parentMerged
								? t("stack.moveToBase", { base: status.nextBase })
								: t("stack.update")}
						</Button>
					)}
				</div>
			) : (
				<div className="space-y-1.5">
					<p className="text-xs text-muted-foreground">{t("stack.description")}</p>
					<div className="flex flex-wrap gap-1.5">
						{pending.map((parent) => (
							<Button
								key={parent.id}
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => stackOn(parent)}
							>
								{t("stack.stackOn", { title: parent.title })}
							</Button>
						))}
					</div>
				</div>
			)}

			{error && (
				<div role="alert" className="mt-1.5 text-xs text-destructive">
					<p>{error}</p>
					{conflicts.length > 0 && (
						<ul className="mt-1 list-disc pl-4">
							{conflicts.map((file) => (
								<li key={file}>
									<code>{file}</code>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
			{note && (
				<p role="status" className="mt-1.5 text-xs text-muted-foreground">
					{note}
				</p>
			)}
		</div>
	);
}
