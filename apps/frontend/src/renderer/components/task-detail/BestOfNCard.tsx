import { GitFork, Loader2, Plus, Trophy, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	BestOfNScore,
	BestOfNState,
	BestOfNStatus,
	EngineTrio,
	Task,
} from "../../../shared/types";
import {
	defaultEngineProvider,
	resolveTaskEngine,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { useConfiguredProviders } from "../../hooks/useConfiguredProviders";
import { loadTasks } from "../../stores/task-store";
import { useSettingsStore } from "../../stores/settings-store";
import { EngineTrioPicker } from "../task-engine/EngineTrioPicker";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 4;

export interface BestOfNCardProps {
	readonly task: Task;
	/** False while the task runs: a best-of-N run replaces the task's build. */
	readonly editable?: boolean;
}

export function engineLabel(engine: EngineTrio): string {
	return `${engine.provider} · ${engine.model} · ${engine.effort}`;
}

/** A run that is still open: its variants exist and wait for a decision. */
export function isOpen(state: BestOfNState | null | undefined): boolean {
	return state?.phase === "running" || state?.phase === "ranked";
}

/**
 * Best-of-N, en une carte.
 *
 * La tâche est construite 2 à 4 fois, chaque fois dans son propre worktree,
 * avec son fournisseur, son modèle et son effort. Quand la dernière variante
 * finit, elles sont classées sur des nombres que la carte montre : build fini,
 * QA (les tests), objectif (goal mode) revérifié dans chaque worktree, taille
 * du diff, coût. Un critère illisible pour une variante ne classe personne.
 * Rien n'est fusionné : la personne choisit, confirme, et les autres variantes
 * sont supprimées.
 */
export function BestOfNCard({ task, editable = true }: BestOfNCardProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const settings = useSettingsStore((s) => s.settings);
	const [status, setStatus] = useState<BestOfNStatus | null>(null);
	const [engines, setEngines] = useState<EngineTrio[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<BestOfNScore | null>(null);
	const [sending, setSending] = useState(false);
	const { providers } = useConfiguredProviders(engines !== null);

	const seed = useMemo((): EngineTrio => {
		const engine = resolveTaskEngine(
			task.metadata,
			seedEngine(settings, task.metadata?.provider || defaultEngineProvider(settings)),
		);
		return engine.coding;
	}, [task.metadata, settings]);

	useEffect(() => {
		const api = globalThis.electronAPI;
		if (typeof api?.getBestOfNStatus !== "function") return;
		let cancelled = false;
		void api
			.getBestOfNStatus(task.id)
			.then((result) => {
				if (!cancelled && result.success && result.data) setStatus(result.data);
			})
			.catch(() => {
				// The card offers a new run; the main process refuses if one is open.
			});
		const stop = api.onBestOfNEvent?.((taskId, next) => {
			if (taskId === task.id) setStatus(next);
		});
		return () => {
			cancelled = true;
			stop?.();
		};
	}, [task.id]);

	const call = useCallback(
		async (action: () => Promise<{ success: boolean; data?: BestOfNStatus; error?: string }>) => {
			setSending(true);
			setError(null);
			try {
				const result = await action();
				if (!result.success) {
					setError(result.error ?? null);
					return false;
				}
				if (result.data) setStatus(result.data);
				return true;
			} finally {
				setSending(false);
			}
		},
		[],
	);

	const state = status?.state ?? null;
	const open = isOpen(state);
	const busy = sending || Boolean(status?.busy);
	// A run replaces the task's build: offered only before there is one.
	const canStart = editable && !open && (task.status === "backlog" || task.status === "queue");
	if (!open && !canStart && !state) return null;

	const start = async () => {
		if (!engines) return;
		const ok = await call(() => globalThis.electronAPI.startBestOfN(task.id, engines));
		if (ok) setEngines(null);
	};

	const adopt = async (score: BestOfNScore) => {
		const ok = await call(() => globalThis.electronAPI.adoptBestOfN(task.id, score.spec_id));
		setConfirm(null);
		if (ok) void loadTasks(task.projectId, { forceRefresh: true });
	};

	const ranking = state?.ranking;
	const running = new Set(status?.running ?? []);

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<GitFork className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:bestOfN.title")}</span>
						{state && (
							<Badge variant="outline" className="text-[10px]">
								{t(`tasks:bestOfN.phase.${state.phase}`)}
							</Badge>
						)}
						{status?.busy && (
							<span className="flex items-center gap-1 text-xs text-muted-foreground">
								<Loader2 className="h-3 w-3 animate-spin" aria-hidden />
								{t(`tasks:bestOfN.busy.${status.busy}`)}
							</span>
						)}
					</div>
					{!state && !engines && (
						<p className="text-xs text-muted-foreground">{t("tasks:bestOfN.description")}</p>
					)}
					{state?.phase === "adopted" && state.adopted && (
						<p className="text-xs">{t("tasks:bestOfN.adoptedLine", { variant: state.adopted.specId })}</p>
					)}
					{state?.phase === "discarded" && (
						<p className="text-xs text-muted-foreground">{t("tasks:bestOfN.discardedLine")}</p>
					)}
				</div>
				{canStart && !engines && (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => {
							setError(null);
							setEngines([{ ...seed }, { ...seed }]);
						}}
					>
						{t("tasks:bestOfN.configure")}
					</Button>
				)}
			</div>

			{engines && (
				<form
					className="mt-3 space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						void start();
					}}
				>
					{engines.map((engine, index) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: a variant is its position
							key={index}
							className="flex items-start gap-2"
						>
							<span className="mt-2 w-6 shrink-0 text-xs text-muted-foreground">#{index + 1}</span>
							<EngineTrioPicker
								value={engine}
								onChange={(trio) =>
									setEngines((prev) => prev?.map((e, i) => (i === index ? trio : e)) ?? prev)
								}
								providers={providers}
								idPrefix={`bon-${task.id}-${index}`}
								disabled={busy}
								className="min-w-0 flex-1"
							/>
							{engines.length > MIN_VARIANTS && (
								<Button
									type="button"
									size="icon"
									variant="ghost"
									aria-label={t("tasks:bestOfN.removeVariant")}
									disabled={busy}
									onClick={() => setEngines((prev) => prev?.filter((_, i) => i !== index) ?? prev)}
								>
									<X className="h-4 w-4" />
								</Button>
							)}
						</div>
					))}
					<p className="text-[11px] text-muted-foreground">{t("tasks:bestOfN.costHint")}</p>
					{error && <p className="text-xs text-destructive">{error}</p>}
					<div className="flex flex-wrap justify-between gap-2">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							disabled={busy || engines.length >= MAX_VARIANTS}
							onClick={() => setEngines((prev) => (prev ? [...prev, { ...seed }] : prev))}
						>
							<Plus className="mr-1 h-3.5 w-3.5" />
							{t("tasks:bestOfN.addVariant")}
						</Button>
						<div className="flex gap-2">
							<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEngines(null)}>
								{t("common:buttons.cancel")}
							</Button>
							<Button type="submit" size="sm" disabled={busy}>
								{t("tasks:bestOfN.start", { count: engines.length })}
							</Button>
						</div>
					</div>
				</form>
			)}

			{state?.phase === "running" && (
				<ul className="mt-3 space-y-1">
					{state.variants.map((variant) => (
						<li key={variant.specId} className="flex flex-wrap items-center gap-2 text-xs">
							<span className="text-muted-foreground">#{variant.index}</span>
							<span className="font-mono">{engineLabel(variant.engine)}</span>
							<Badge variant="outline" className="text-[10px]">
								{running.has(variant.specId)
									? t("tasks:bestOfN.variant.running")
									: variant.interrupted
										? t("tasks:bestOfN.variant.interrupted")
										: variant.exitCode === null
											? t("tasks:bestOfN.variant.starting")
											: t("tasks:bestOfN.variant.ended", { code: variant.exitCode })}
							</Badge>
						</li>
					))}
				</ul>
			)}

			{state?.phase === "ranked" && ranking && (
				<div className="mt-3 space-y-2">
					<div className="overflow-x-auto">
						<table className="w-full text-left text-xs">
							<thead className="text-muted-foreground">
								<tr>
									<th className="py-1 pr-2">{t("tasks:bestOfN.columns.rank")}</th>
									<th className="py-1 pr-2">{t("tasks:bestOfN.columns.engine")}</th>
									<th className="py-1 pr-2">{t("tasks:bestOfN.columns.build")}</th>
									<th className="py-1 pr-2">{t("tasks:bestOfN.columns.tests")}</th>
									<th className="py-1 pr-2">{t("tasks:bestOfN.columns.goal")}</th>
									<th className="py-1 pr-2">{t("tasks:bestOfN.columns.diff")}</th>
									<th className="py-1 pr-2">{t("tasks:bestOfN.columns.cost")}</th>
									<th className="py-1" />
								</tr>
							</thead>
							<tbody>
								{ranking.variants.map((score) => (
									<tr key={score.spec_id} className="border-t border-border/60">
										<td className="py-1 pr-2 font-medium">
											{score.rank}
											{ranking.recommended === score.spec_id && (
												<Trophy
													className="ml-1 inline h-3 w-3 text-warning"
													aria-label={t("tasks:bestOfN.recommended")}
												/>
											)}
										</td>
										<td className="py-1 pr-2 font-mono">{engineLabel(score.engine)}</td>
										<td className="py-1 pr-2">
											{score.subtasks_done}/{score.subtasks_total}
										</td>
										<td className="py-1 pr-2">
											{score.qa_status
												? t(`tasks:bestOfN.qa.${score.qa_status === "approved" || score.qa_status === "rejected" ? score.qa_status : "other"}`)
												: "—"}
										</td>
										<td className="py-1 pr-2" title={score.goal_reason || undefined}>
											{score.goal_status ? t(`tasks:goal.status.${score.goal_status}`, score.goal_status) : "—"}
										</td>
										<td className="py-1 pr-2">
											{score.diff_lines === null
												? "—"
												: t("tasks:bestOfN.diffValue", {
														lines: score.diff_lines,
														files: score.diff_files ?? 0,
													})}
										</td>
										<td className="py-1 pr-2">
											{score.cost_usd === null
												? "—"
												: `${score.cost_complete ? "" : "≥ "}$${score.cost_usd.toFixed(2)}`}
										</td>
										<td className="py-1 text-right">
											<Button
												size="sm"
												variant={ranking.recommended === score.spec_id ? "default" : "outline"}
												disabled={busy || !score.worktree}
												onClick={() => setConfirm(score)}
											>
												{t("tasks:bestOfN.adopt")}
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="text-[11px] text-muted-foreground">
						{t("tasks:bestOfN.criteriaUsed", {
							list: ranking.criteria.map((c) => t(`tasks:bestOfN.columns.${c}`)).join(" › "),
						})}
					</p>
					{Object.entries(ranking.skipped).map(([criterion, reason]) => (
						<p key={criterion} className="text-[11px] text-muted-foreground">
							{t(`tasks:bestOfN.skipped.${reason}`)}
						</p>
					))}
					{!ranking.recommended && (
						<p className="text-[11px] text-muted-foreground">{t("tasks:bestOfN.noRecommendation")}</p>
					)}
				</div>
			)}

			{open && (
				<div className="mt-3 flex flex-wrap justify-end gap-2">
					{error && <p className="mr-auto text-xs text-destructive">{error}</p>}
					{!error && status?.error && <p className="mr-auto text-xs text-destructive">{status.error}</p>}
					{state?.phase === "running" && running.size === 0 && !status?.busy && (
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void call(() => globalThis.electronAPI.rankBestOfN(task.id))}>
							{t("tasks:bestOfN.rank")}
						</Button>
					)}
					{state?.phase === "ranked" && (
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => void call(() => globalThis.electronAPI.rankBestOfN(task.id))}>
							{t("tasks:bestOfN.rerank")}
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						disabled={busy && status?.busy !== "ranking"}
						onClick={() => void call(() => globalThis.electronAPI.discardBestOfN(task.id))}
					>
						{t("tasks:bestOfN.discard")}
					</Button>
				</div>
			)}

			<AlertDialog open={confirm !== null} onOpenChange={(next) => !next && setConfirm(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("tasks:bestOfN.confirmTitle")}</AlertDialogTitle>
						<AlertDialogDescription>
							{confirm &&
								t("tasks:bestOfN.confirmBody", {
									engine: engineLabel(confirm.engine),
									others: (ranking?.variants.length ?? 1) - 1,
								})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>{t("common:buttons.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							disabled={busy}
							onClick={(event) => {
								event.preventDefault();
								if (confirm) void adopt(confirm);
							}}
						>
							{t("tasks:bestOfN.adopt")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
