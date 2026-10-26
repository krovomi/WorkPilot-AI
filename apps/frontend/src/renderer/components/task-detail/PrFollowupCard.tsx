import { GitPullRequest, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	PrFollowupDecision,
	PrFollowupStatus,
	Task,
} from "../../../shared/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface PrFollowupCardProps {
	readonly task: Task;
}

type Variant = "success" | "destructive" | "warning" | "muted" | "outline";

export function decisionVariant(decision: PrFollowupDecision): Variant {
	switch (decision) {
		case "green":
		case "merged":
			return "success";
		case "stuck":
		case "exhausted":
		case "unknown":
			return "destructive";
		case "fix":
		case "pending":
		case "base_red":
		case "no_checks":
			return "warning";
		case "closed":
			return "muted";
	}
}

const shortSha = (sha: string) => sha.slice(0, 8);

/**
 * Le suivi de la PR, en une carte.
 *
 * Une tâche qui a ouvert sa pull request ne s'arrête plus à « PR créée » : la
 * carte peut continuer de la faire avancer. Un check rouge ou un fil de revue
 * non résolu part au QA fixer dans le worktree de la tâche ; le commit est
 * vérifié (aucun test sauté, supprimé ou désactivé, aucun fichier de CI
 * modifié) puis poussé, jamais en force. Le merge reste à une personne.
 *
 * La carte dit le dernier verdict lu sur la PR et ce qui a été fait. Elle ne
 * s'affiche que pour une tâche qui a une PR.
 */
export function PrFollowupCard({ task }: PrFollowupCardProps) {
	const { t } = useTranslation(["tasks"]);
	const prUrl = task.prUrl ?? task.metadata?.prUrl;
	const [status, setStatus] = useState<PrFollowupStatus>({ running: false });
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!prUrl) return;
		const api = globalThis.electronAPI;
		let cancelled = false;
		if (typeof api?.getPrFollowupStatus === "function") {
			void api
				.getPrFollowupStatus(task.id)
				.then((result) => {
					if (!cancelled && result.success && result.data) setStatus(result.data);
				})
				.catch(() => {
					// Best-effort: the event stream keeps the card in sync.
				});
		}
		const unsubscribe =
			typeof api?.onPrFollowupEvent === "function"
				? api.onPrFollowupEvent((taskId, next) => {
						if (taskId === task.id) setStatus(next);
					})
				: undefined;
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [task.id, prUrl]);

	if (!prUrl) return null;

	const toggle = async () => {
		setBusy(true);
		setError(null);
		try {
			const api = globalThis.electronAPI;
			const result = status.running
				? await api.stopPrFollowup(task.id)
				: await api.startPrFollowup(task.id);
			if (!result.success) setError(result.error ?? null);
			else if (result.data) setStatus(result.data);
		} finally {
			setBusy(false);
		}
	};

	const round = status.round;
	const message = error ?? status.error;

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<GitPullRequest className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:prFollowup.title")}</span>
						{status.running && (
							<Badge variant="outline" className="gap-1 text-[10px]">
								<Loader2 className="h-3 w-3 animate-spin" aria-hidden />
								{t("tasks:prFollowup.running")}
							</Badge>
						)}
						{round && (
							<Badge variant={decisionVariant(round.decision)} className="text-[10px]">
								{t(`tasks:prFollowup.decision.${round.decision}`)}
							</Badge>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						{round?.reason || t("tasks:prFollowup.description")}
					</p>
					{round && round.action !== "none" && (
						<p className="text-xs">{t(`tasks:prFollowup.action.${round.action}`)}</p>
					)}
					{round?.pushed_sha && (
						<p className="text-xs text-muted-foreground">
							{t("tasks:prFollowup.pushed", { sha: shortSha(round.pushed_sha) })}
						</p>
					)}
					{round && round.failing.length > 0 && (
						<p className="text-xs text-muted-foreground">
							{t("tasks:prFollowup.failing", { names: round.failing.join(", ") })}
						</p>
					)}
					{round && round.base_failing.length > 0 && (
						<p className="text-xs text-muted-foreground">
							{t("tasks:prFollowup.baseFailing", {
								names: round.base_failing.join(", "),
							})}
						</p>
					)}
					{round && round.threads.length > 0 && (
						<p className="text-xs text-muted-foreground">
							{t("tasks:prFollowup.threads", { count: round.threads.length })}
						</p>
					)}
					{round && round.violations.length > 0 && (
						<p className="text-xs text-destructive">
							{t("tasks:prFollowup.violations", {
								list: round.violations.join("; "),
							})}
						</p>
					)}
					{message && <p className="text-xs text-destructive">{message}</p>}
				</div>
				<Button
					size="sm"
					variant={status.running ? "outline" : "default"}
					disabled={busy}
					onClick={() => void toggle()}
				>
					{status.running ? t("tasks:prFollowup.stop") : t("tasks:prFollowup.start")}
				</Button>
			</div>
		</div>
	);
}
