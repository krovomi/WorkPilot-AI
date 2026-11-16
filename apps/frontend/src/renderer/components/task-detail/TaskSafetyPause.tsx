import { History, RotateCcw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	AnomalyPauseDetail,
	AnomalyRecord,
	SandboxPauseDetail,
	Task,
	TaskSnapshot,
} from "../../../shared/types";
import { formatAppDateTime } from "../../lib/date-format";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export type SafetyPause =
	| { reason: "anomaly"; detail: AnomalyPauseDetail }
	| { reason: "sandbox"; detail: SandboxPauseDetail };

const SANDBOX_KINDS = new Set(["restricted_path", "file_size", "files_written", "session_time"]);
const PHASE_LABELS = new Set(["planning", "coding", "qa_review", "before_rollback"]);

/** The anomalies grouped by type, in the order they first appeared. */
export function countByType(anomalies: readonly AnomalyRecord[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const anomaly of anomalies) counts.set(anomaly.type, (counts.get(anomaly.type) ?? 0) + 1);
	return [...counts.entries()];
}

/** What the session watch recorded when it paused the task, or null. */
export function safetyPause(task: Task): SafetyPause | null {
	const paused = task.metadata?.paused;
	if (!paused?.enabled) return null;
	if (paused.reason === "anomaly") {
		const detail = paused.anomaly;
		return detail && typeof detail.trustScore === "number" && Array.isArray(detail.anomalies)
			? { reason: "anomaly", detail }
			: null;
	}
	if (paused.reason === "sandbox") {
		const detail = paused.sandbox;
		return detail && SANDBOX_KINDS.has(detail.kind) ? { reason: "sandbox", detail } : null;
	}
	return null;
}

function SnapshotList({ taskId }: { readonly taskId: string }) {
	const { t } = useTranslation(["tasks"]);
	const [snapshots, setSnapshots] = useState<TaskSnapshot[] | null>(null);
	const [error, setError] = useState<{ key: "failed" | "listFailed"; text: string } | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [restored, setRestored] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = async () => {
		setBusy(true);
		setError(null);
		const result = await window.electronAPI.listTaskSnapshots(taskId);
		setBusy(false);
		if (result.success) setSnapshots(result.data ?? []);
		else setError({ key: "listFailed", text: result.error ?? "" });
	};

	const restore = async (snapshotId: string) => {
		setBusy(true);
		setError(null);
		const result = await window.electronAPI.restoreTaskSnapshot(taskId, snapshotId);
		setBusy(false);
		setConfirming(null);
		if (result.success && result.data) {
			setRestored(snapshotId);
			await load();
		} else {
			setError({ key: "failed", text: result.error ?? "" });
		}
	};

	const errorLine = error && (
		<p className="text-xs text-destructive">
			{t(`tasks:safetyPause.snapshots.${error.key}`, { error: error.text })}
		</p>
	);

	if (snapshots === null) {
		return (
			<div className="space-y-2">
				{errorLine}
				<Button
				variant="outline"
				size="sm"
				className="gap-1.5"
				onClick={load}
				disabled={busy}
				data-testid="task-snapshots-open"
			>
				<History className="h-4 w-4" />
				{t("tasks:safetyPause.snapshots.open")}
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-2" data-testid="task-snapshots">
			{restored && (
				<p className="text-xs text-success">{t("tasks:safetyPause.snapshots.restored")}</p>
			)}
			{errorLine}
			{snapshots.length === 0 && (
				<p className="text-xs text-muted-foreground">{t("tasks:safetyPause.snapshots.none")}</p>
			)}
			<ul className="max-h-48 space-y-1 overflow-y-auto">
				{snapshots.map((snapshot) => (
					<li
						key={snapshot.snapshot_id}
						className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1"
					>
						<span className="text-xs">
							{formatAppDateTime(snapshot.created_at)}
							{" · "}
							{PHASE_LABELS.has(snapshot.label)
								? t(`tasks:safetyPause.snapshots.labels.${snapshot.label}`)
								: snapshot.label}
						</span>
						{confirming === snapshot.snapshot_id ? (
							<Button
								variant="destructive"
								size="sm"
								onClick={() => restore(snapshot.snapshot_id)}
								disabled={busy}
								data-testid="task-snapshot-confirm"
							>
								{t("tasks:safetyPause.snapshots.confirm")}
							</Button>
						) : (
							<Button
								variant="ghost"
								size="sm"
								className="gap-1"
								onClick={() => setConfirming(snapshot.snapshot_id)}
								disabled={busy}
								data-testid="task-snapshot-restore"
							>
								<RotateCcw className="h-3.5 w-3.5" />
								{t("tasks:safetyPause.snapshots.restore")}
							</Button>
						)}
					</li>
				))}
			</ul>
			<p className="text-xs text-muted-foreground">{t("tasks:safetyPause.snapshots.hint")}</p>
		</div>
	);
}

/**
 * Why the session watch paused a task (`agents/safety_watch.py`): its trust
 * score fell to a threshold, or a sandbox limit was crossed. Says whether the
 * worktree was put back on the snapshot taken before the session, and lists
 * the task's snapshots so the person can restore one. Resuming is the Resume
 * button beside it.
 */
export function TaskSafetyPause({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const pause = safetyPause(task);
	if (!pause) return null;
	const { detail } = pause;
	const stopped = pause.reason === "anomaly" ? pause.detail.stopped : Boolean(detail.rollback);

	const chip =
		pause.reason === "anomaly"
			? t("tasks:safetyPause.anomalyChip", { score: Math.round(pause.detail.trustScore) })
			: t(`tasks:safetyPause.sandboxChip.${pause.detail.kind}`);

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant={stopped ? "destructive" : "warning"}
					size="sm"
					className="gap-1.5"
					data-testid="task-safety-pause"
				>
					<ShieldAlert className="h-4 w-4" />
					{chip}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-96 space-y-3 text-sm">
				{pause.reason === "anomaly" ? (
					<>
						<p>
							{t(stopped ? "tasks:safetyPause.anomalyStopped" : "tasks:safetyPause.anomalyBody", {
								score: Math.round(pause.detail.trustScore),
								pause: pause.detail.pauseBelow,
								stop: pause.detail.stopBelow,
							})}
						</p>
						{pause.detail.anomalies.length > 0 && (
							<ul className="list-disc space-y-0.5 pl-5 text-xs">
								{countByType(pause.detail.anomalies).map(([type, count]) => (
									<li key={type}>
										{t("tasks:safetyPause.anomalyLine", {
											label: t(`tasks:safetyPause.types.${type}`, { defaultValue: type }),
											count,
										})}
									</li>
								))}
							</ul>
						)}
					</>
				) : (
					<p>
						{t(`tasks:safetyPause.sandboxBody.${pause.detail.kind}`, {
							path: pause.detail.path ?? "",
							value: pause.detail.value ?? 0,
							limit: pause.detail.limit ?? 0,
						})}
					</p>
				)}
				{detail.rolledBack && (
					<p className="text-xs" data-testid="task-safety-rolled-back">
						{t("tasks:safetyPause.rolledBack")}
					</p>
				)}
				{detail.rollbackError && (
					<p className="text-xs text-destructive">{t("tasks:safetyPause.rollbackFailed")}</p>
				)}
				<p className="text-xs text-muted-foreground">{t("tasks:safetyPause.hint")}</p>
				<SnapshotList taskId={task.id} />
			</PopoverContent>
		</Popover>
	);
}
