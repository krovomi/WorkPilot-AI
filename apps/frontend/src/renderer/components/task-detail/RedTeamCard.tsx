import { Loader2, Swords } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import {
	fetchRedTeam,
	type RedTeamAttack,
	type RedTeamRecord,
	runRedTeam,
} from "../../lib/agent-tools-api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface RedTeamCardProps {
	readonly task: Task;
	/** Absolute project path; the backend derives the spec directory from it. */
	readonly projectPath?: string;
}

type Variant = "success" | "destructive" | "warning" | "outline";

const STATUS_VARIANTS: Record<RedTeamRecord["status"], Variant> = {
	pass: "success",
	fail: "destructive",
	unknown: "warning",
	none: "outline",
};

const OUTCOME_VARIANTS: Record<RedTeamAttack["outcome"], Variant> = {
	crash: "destructive",
	unexpected: "warning",
	resistant: "success",
	not_run: "outline",
	flaky: "outline",
};

/** Crashes first, then what needs a look, then what held. */
const ORDER: readonly RedTeamAttack["outcome"][] = [
	"crash",
	"unexpected",
	"resistant",
	"flaky",
	"not_run",
];

/**
 * La red team, en une carte.
 *
 * Après la QA, un agent a essayé de casser ce que la tâche a construit :
 * entrées malformées, limites, injection de prompt, concurrence, anciens bugs.
 * WorkPilot a lancé lui-même chaque test d'attaque. La carte dit ce qui a fait
 * planter le code (bloquant), ce qui a répondu autrement que prévu (à regarder),
 * ce qui a tenu, et les risques de concurrence vus sans modèle. « Attaquer » lance
 * une nouvelle attaque sur le code de la tâche.
 *
 * Sans enregistrement, la carte ne s'affiche pas.
 */
export function RedTeamCard({ task, projectPath }: RedTeamCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [record, setRecord] = useState<RedTeamRecord | null>(null);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const query = useCallback(
		() => ({ projectDir: projectPath, specId: task.specId }),
		[projectPath, task.specId],
	);

	useEffect(() => {
		if (!projectPath || !task.specId) return;
		const controller = new AbortController();
		void fetchRedTeam(query(), controller.signal).then((res) => {
			if (res.ok) setRecord(res.data.record);
		});
		return () => controller.abort();
	}, [projectPath, task.specId, query]);

	if (!projectPath || !record) return null;

	const attack = async () => {
		setRunning(true);
		setError(null);
		const res = await runRedTeam(query());
		setRunning(false);
		if (res.ok) setRecord(res.data.record);
		else setError(res.error);
	};

	const attacks = [...record.attacks].sort(
		(a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome),
	);

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3" data-testid="red-team-card">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<Swords className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:redTeam.title")}</span>
						<Badge variant={STATUS_VARIANTS[record.status]} className="text-3xs">
							{t(`tasks:redTeam.status.${record.status}`)}
						</Badge>
						{record.run === "replay" && (
							<Badge variant="outline" className="text-3xs">
								{t("tasks:redTeam.replay")}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("tasks:redTeam.counts", {
							crash: record.counts.crash,
							unexpected: record.counts.unexpected,
							resistant: record.counts.resistant,
							warning: record.counts.warning,
						})}
					</p>
				</div>
				<Button size="sm" variant="outline" disabled={running} onClick={() => void attack()}>
					{running && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />}
					{running ? t("tasks:redTeam.running") : t("tasks:redTeam.attack")}
				</Button>
			</div>
			{error && (
				<p className="mt-2 text-xs text-destructive" role="alert">
					{error}
				</p>
			)}
			{attacks.length > 0 && (
				<ul className="mt-3 grid gap-2">
					{attacks.map((a) => (
						<li key={a.id} className="text-xs" data-testid="red-team-attack">
							<div className="flex flex-wrap items-baseline gap-2">
								<Badge variant={OUTCOME_VARIANTS[a.outcome]} className="text-3xs">
									{t(`tasks:redTeam.outcome.${a.outcome}`)}
								</Badge>
								<span className="text-muted-foreground">{t(`tasks:redTeam.mode.${a.mode}`)}</span>
								<span className="break-all font-mono">{a.target || a.file}</span>
							</div>
							{a.input && (
								<p className="mt-0.5 break-words">
									{t("tasks:redTeam.input", { input: a.input })}
									{a.expect ? ` ${t("tasks:redTeam.expect", { expect: a.expect })}` : ""}
								</p>
							)}
							{a.outcome === "crash" && a.detail && (
								<pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-3xs">
									{a.detail}
								</pre>
							)}
						</li>
					))}
				</ul>
			)}
			{record.warnings.length > 0 && (
				<div className="mt-3">
					<p className="text-xs font-medium">{t("tasks:redTeam.warnings")}</p>
					<ul className="mt-1 grid gap-1">
						{record.warnings.map((w) => (
							<li key={`${w.path}:${w.line}:${w.kind}`} className="text-xs">
								<span className="font-mono">{`${w.path}:${w.line}`}</span>
								{` ${t(`tasks:redTeam.warning.${w.kind}`)}`}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
