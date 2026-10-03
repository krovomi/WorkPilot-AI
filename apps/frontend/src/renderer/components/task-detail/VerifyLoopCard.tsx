import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { useVerifyStore } from "../../stores/verify-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	endpointSummary,
	measured,
	remainingErrors,
	roundsSummary,
	statusVariant,
} from "./verify-view";

export interface VerifyLoopCardProps {
	readonly task: Task;
	/** Absolute project path; the server derives the spec directory from it. */
	readonly projectPath?: string;
	/** Opens the Verification tab, when the modal offers one. */
	readonly onOpenDetails?: () => void;
}

/**
 * La boucle de vérification, en une carte.
 *
 * L'application que la tâche a modifiée a-t-elle été lancée, sans erreur,
 * jusqu'à l'état attendu, et avec quelle performance ? La carte le dit d'une
 * ligne — verdict, tours de correction, endpoints conformes, score — et offre
 * de relancer la vérification sur le code de la tâche. Le détail (captures,
 * endpoints, métriques, scénario) est dans l'onglet « Vérification ».
 *
 * Elle ne s'affiche que quand une vérification a eu lieu : pas
 * d'enregistrement, pas de carte.
 */
export function VerifyLoopCard({ task, projectPath, onOpenDetails }: VerifyLoopCardProps) {
	const { t } = useTranslation(["tasks"]);
	const load = useVerifyStore((s) => s.load);
	const run = useVerifyStore((s) => s.run);
	const entry = useVerifyStore((s) => s.byTask[task.id]);
	const record = entry?.data?.record ?? null;

	useEffect(() => {
		if (!projectPath) return;
		void load(task.id, { projectDir: projectPath, specId: task.specId });
	}, [task.id, task.specId, projectPath, load]);

	if (!projectPath || !record || record.status === "disabled") return null;

	const running = entry?.busy === "running";
	const errors = remainingErrors(record);
	const { rounds, fixed } = roundsSummary(record);
	const endpoints = endpointSummary(record);
	const score = measured(record.score);

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<ShieldCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:verify.title")}</span>
						<Badge variant={statusVariant(record.status)} className="text-[10px]">
							{t(`tasks:verify.status.${record.status}`)}
						</Badge>
						{score !== null && (
							<Badge variant="outline" className="text-[10px]">
								{t("tasks:verify.badge.score", { score })}
							</Badge>
						)}
						{rounds > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("tasks:verify.badge.rounds", { count: rounds, fixed })}
							</Badge>
						)}
						{endpoints.called > 0 && (
							<Badge
								variant={endpoints.ok === endpoints.called ? "outline" : "destructive"}
								className="text-[10px]"
							>
								{t("tasks:verify.badge.endpoints", {
									ok: endpoints.ok,
									count: endpoints.called,
								})}
							</Badge>
						)}
						{errors > 0 && (
							<Badge variant="destructive" className="text-[10px]">
								{t("tasks:verify.badge.errors", { count: errors })}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{record.reason || t(`tasks:verify.subtitle.${record.status}`)}
					</p>
					{record.replay?.status === "fail" && (
						<p className="mt-1 text-xs text-destructive">
							{t("tasks:verify.replayFailed")}
						</p>
					)}
					{entry?.error && (
						<p role="alert" className="mt-1 text-xs text-destructive">
							{t("tasks:verify.error", { error: entry.error })}
						</p>
					)}
				</div>
				<div className="flex shrink-0 gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={running}
						onClick={() =>
							void run(task.id, { projectDir: projectPath, specId: task.specId })
						}
					>
						{running && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
						{running ? t("tasks:verify.running") : t("tasks:verify.rerun")}
					</Button>
					{onOpenDetails && (
						<Button size="sm" variant="ghost" onClick={onOpenDetails}>
							{t("tasks:verify.details")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
