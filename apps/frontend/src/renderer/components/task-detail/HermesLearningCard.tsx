import { BrainCircuit, CircleAlert, CircleCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHermesStore } from "../../stores/hermes-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * La boucle d'apprentissage hermes-agent, vue depuis le Kanban.
 *
 * hermes tourne là où WorkPilot ne regarde pas — Telegram, une tâche cron, un
 * terminal — et y écrit des skills tirés de sa propre expérience. Cette carte
 * est la première surface WorkPilot qui ouvre ce cycle : elle dit si hermes
 * peut fonctionner sur cette machine, ce qui manque quand ce n'est pas le cas,
 * et elle dépose ce qu'il a appris dans la file de revue `skills/_proposed/`.
 *
 * Deux choses qu'elle ne fait délibérément pas :
 *
 * - **promouvoir**. Un candidat issu d'hermes ne porte aucun signal externe :
 *   la validation d'hermes est un humain qui approuve un texte, pas
 *   l'observation d'un build qui s'en est servi. Le compter comme
 *   corroboration fabriquerait exactement la preuve que `skill_proposer`
 *   refuse d'inventer ;
 * - **accorder la confiance**. Le bouton n'existe pas pour
 *   `hermes skills trust` : approuver un dépôt rend chaque SKILL.md qu'il
 *   contient exécutable par hermes dans toutes ses sessions. C'est la porte
 *   que la barrière anti-injection ferme, et un logiciel qui se l'ouvre
 *   lui-même l'a supprimée. La carte affiche la commande ; la personne la tape.
 *
 * Elle ne s'affiche pas quand hermes n'est pas installé : une carte permanente
 * qui dit « fonctionnalité non utilisée » est une carte que personne ne lit.
 */
export function HermesLearningCard() {
	const { t } = useTranslation(["hermes"]);
	const [expanded, setExpanded] = useState(false);

	const status = useHermesStore((s) => s.status);
	const lastCycle = useHermesStore((s) => s.lastCycle);
	const running = useHermesStore((s) => s.running);
	const error = useHermesStore((s) => s.error);
	const load = useHermesStore((s) => s.load);
	const runCycle = useHermesStore((s) => s.runCycle);
	const installSoul = useHermesStore((s) => s.installSoul);

	useEffect(() => {
		void load();
	}, [load]);

	if (!status?.readiness.installed) return null;

	const { readiness, soul, pending } = status;
	const unmet = readiness.checks.filter((c) => !c.ok);
	const soulMissing = soul.offered && !soul.installed;

	return (
		<div className="rounded-lg border border-violet-500/40 bg-violet-500/5">
			<div className="flex items-start justify-between gap-3 p-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<BrainCircuit
							className="h-4 w-4 shrink-0 text-violet-500"
							aria-hidden
						/>
						<span className="text-sm font-medium">{t("hermes:title")}</span>
						<Badge variant="outline" className="text-[10px]">
							{t(`hermes:state.${readiness.state}`)}
						</Badge>
						{pending.length > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("hermes:badge.pending", { count: pending.length })}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("hermes:subtitle")}
					</p>
					{lastCycle?.ingest && (
						<p className="mt-2 text-xs text-muted-foreground">
							{t("hermes:cycle.result", {
								found: lastCycle.ingest.found,
								proposed: lastCycle.ingest.proposed,
								unchanged: lastCycle.ingest.unchanged,
							})}
						</p>
					)}
					{error && (
						<p className="mt-2 text-xs text-destructive">{error}</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						size="sm"
						variant="ghost"
						disabled={running}
						onClick={() => void runCycle("kanban")}
					>
						{running ? t("hermes:cycle.running") : t("hermes:cycle.run")}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
					>
						{expanded ? t("hermes:collapse") : t("hermes:expand")}
					</Button>
				</div>
			</div>

			{expanded && (
				<div className="space-y-3 border-t border-violet-500/20 p-3">
					<section>
						<h4 className="text-xs font-medium">{t("hermes:checks.title")}</h4>
						<ul className="mt-1 space-y-1">
							{readiness.checks.map((check) => (
								<li
									key={check.name}
									className="flex items-start gap-2 text-xs text-muted-foreground"
								>
									{check.ok ? (
										<CircleCheck
											className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500"
											aria-hidden
										/>
									) : (
										<CircleAlert
											className="mt-0.5 h-3 w-3 shrink-0 text-amber-500"
											aria-hidden
										/>
									)}
									<span className="min-w-0">
										<span className="font-medium">
											{t(`hermes:checks.${check.name}`, check.name)}
										</span>
										<span className="ml-1">{check.detail}</span>
										{check.remedy && (
											<code className="mt-1 block break-all rounded bg-muted px-1 py-0.5 text-[10px]">
												{check.remedy}
											</code>
										)}
									</span>
								</li>
							))}
						</ul>
					</section>

					{soulMissing && (
						<section>
							<h4 className="text-xs font-medium">{t("hermes:soul.title")}</h4>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("hermes:soul.description")}
							</p>
							<Button
								size="sm"
								variant="outline"
								className="mt-2"
								disabled={running}
								onClick={() => void installSoul(soul.state === "diverged")}
							>
								<Sparkles className="mr-1 h-3 w-3" aria-hidden />
								{soul.state === "diverged"
									? t("hermes:soul.replace")
									: t("hermes:soul.install")}
							</Button>
						</section>
					)}

					{pending.length > 0 && (
						<section>
							<h4 className="text-xs font-medium">
								{t("hermes:pending.title")}
							</h4>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("hermes:pending.description")}
							</p>
							<ul className="mt-1 space-y-0.5">
								{pending.map((name) => (
									<li
										key={name}
										className="truncate font-mono text-[10px] text-muted-foreground"
									>
										skills/_proposed/{name}
									</li>
								))}
							</ul>
						</section>
					)}

					{unmet.length === 0 && pending.length === 0 && (
						<p className="text-xs text-muted-foreground">
							{t("hermes:empty")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
