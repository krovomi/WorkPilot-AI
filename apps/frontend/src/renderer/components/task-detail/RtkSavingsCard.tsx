import { CircleAlert, CircleCheck, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRtkStore } from "../../stores/rtk-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * rtk, vu depuis le Kanban.
 *
 * rtk est un proxy CLI : il exécute la commande demandée et n'imprime qu'une
 * version condensée de sa sortie. Comportement et code de retour inchangés,
 * une fraction des octets — et la sortie de commandes est le plus gros poste
 * d'entrée que paient les agents. Cette carte répond à deux questions :
 * est-ce que ça marche ici, et qu'est-ce que ça a économisé sur ce projet.
 *
 * Trois décisions qu'elle assume :
 *
 * - **elle ne s'affiche pas quand rtk n'est pas installé**. Une carte
 *   permanente qui dit « fonctionnalité non utilisée » est une carte que
 *   personne ne lit ; la découverte se fait dans les Réglages, qui est
 *   l'endroit où l'on va chercher ce qu'on pourrait activer ;
 * - **elle n'a pas de bouton d'installation**. `rtk init -g` écrit un hook
 *   dans les réglages Claude Code de la personne, pour *toutes* ses sessions
 *   sur la machine et pas seulement celles que WorkPilot pilote. Même
 *   raisonnement que la barrière de confiance d'hermes : la carte affiche la
 *   commande, la personne la tape ;
 * - **elle annonce une estimation, pas une facture**. rtk n'embarque pas de
 *   tokenizer et compte octets / 4, et la sortie shell n'est qu'une partie
 *   des entrées, elles-mêmes une partie de la note. Le nombre est celui qui a
 *   été mesuré ; l'extrapolation n'est faite par personne.
 */
export function RtkSavingsCard({ projectPath }: { projectPath?: string }) {
	const { t } = useTranslation(["rtk"]);
	const [expanded, setExpanded] = useState(false);

	const status = useRtkStore((s) => s.status);
	const load = useRtkStore((s) => s.load);

	useEffect(() => {
		void load(projectPath);
	}, [load, projectPath]);

	if (!status?.readiness.installed) return null;

	const { readiness, savings } = status;
	const unmet = readiness.checks.filter((c) => !c.ok);

	return (
		<div className="rounded-lg border border-amber-500/40 bg-amber-500/5">
			<div className="flex items-start justify-between gap-3 p-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<Zap className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
						<span className="text-sm font-medium">{t("rtk:title")}</span>
						<Badge variant="outline" className="text-[10px]">
							{t(`rtk:state.${readiness.state}`)}
						</Badge>
						{readiness.version && (
							<Badge variant="outline" className="text-[10px]">
								{readiness.version}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("rtk:subtitle")}
					</p>
					{savings.available && savings.commands > 0 ? (
						<p className="mt-2 text-xs text-muted-foreground">
							{t("rtk:savings.summary", {
								commands: savings.commands,
								percent: savings.averagePct,
								tokens: savings.savedTokens.toLocaleString(),
							})}
						</p>
					) : (
						<p className="mt-2 text-xs text-muted-foreground">
							{t("rtk:savings.none")}
						</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						size="sm"
						variant="ghost"
						onClick={() => void load(projectPath, true)}
					>
						{t("rtk:refresh")}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
					>
						{expanded ? t("rtk:collapse") : t("rtk:expand")}
					</Button>
				</div>
			</div>

			{expanded && (
				<div className="space-y-3 border-t border-amber-500/20 p-3">
					<section>
						<h4 className="text-xs font-medium">{t("rtk:checks.title")}</h4>
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
											{t(`rtk:checks.${check.name}`, {
												defaultValue: check.name,
											})}
										</span>
										{check.detail && <span> — {check.detail}</span>}
										{!check.ok && check.remedy && (
											<code className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px]">
												{check.remedy}
											</code>
										)}
									</span>
								</li>
							))}
						</ul>
					</section>

					{savings.available && savings.commands > 0 && (
						<section>
							<h4 className="text-xs font-medium">{t("rtk:savings.title")}</h4>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("rtk:savings.detail", {
									input: savings.inputBytes.toLocaleString(),
									output: savings.outputBytes.toLocaleString(),
								})}
							</p>
							<p className="mt-1 text-[10px] text-muted-foreground">
								{t("rtk:savings.caveat")}
							</p>
						</section>
					)}

					{unmet.length === 0 && (
						<p className="text-xs text-muted-foreground">{t("rtk:allGood")}</p>
					)}
				</div>
			)}
		</div>
	);
}
