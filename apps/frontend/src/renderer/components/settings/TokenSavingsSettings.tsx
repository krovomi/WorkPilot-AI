import type { ProjectEnvConfig } from "@shared/types";
import { CircleAlert, CircleCheck, ExternalLink, Zap } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRtkStore } from "../../stores/rtk-store";
import { Switch } from "../ui/switch";

/**
 * rtk dans les réglages — l'endroit où on le découvre.
 *
 * La carte du Kanban ne s'affiche que si rtk est installé, pour la raison
 * habituelle : une carte permanente qui dit « non utilisé » est une carte que
 * personne ne lit. Mais quelqu'un doit pouvoir apprendre que la fonction
 * existe, et les réglages sont précisément l'endroit où l'on va chercher ce
 * qu'on pourrait activer. Cette section s'affiche donc toujours, et quand rtk
 * est absent elle dit comment l'installer au lieu de se taire.
 *
 * Les deux interrupteurs sont volontairement séparés. Le premier change ce
 * qu'un modèle lit ; le second change ce qu'un chemin de code de WorkPilot
 * reçoit. Ce n'est pas le même risque, donc ce n'est pas la même décision.
 */
export function TokenSavingsSettings({
	tokenSavings,
	projectPath,
	onUpdate,
}: {
	tokenSavings: ProjectEnvConfig["tokenSavings"];
	projectPath?: string;
	onUpdate: (
		key: keyof NonNullable<ProjectEnvConfig["tokenSavings"]>,
		value: boolean,
	) => void;
}) {
	const { t } = useTranslation(["rtk"]);
	const status = useRtkStore((s) => s.status);
	const load = useRtkStore((s) => s.load);

	useEffect(() => {
		void load(projectPath);
	}, [load, projectPath]);

	const installed = status?.readiness.installed ?? false;
	const terminalHook =
		status?.readiness.checks.find((c) => c.name === "terminal-hook")?.ok ??
		false;
	const enabled = tokenSavings?.rtkEnabled !== false;

	return (
		<div className="pt-4 border-t border-border">
			<div className="flex items-center gap-2 mb-3">
				<Zap className="h-3 w-3 text-muted-foreground" />
				<span className="text-xs text-muted-foreground uppercase tracking-wider">
					{t("rtk:settings.title")}
				</span>
				{installed ? (
					<CircleCheck className="h-3 w-3 text-emerald-500" aria-hidden />
				) : (
					<CircleAlert className="h-3 w-3 text-muted-foreground" aria-hidden />
				)}
			</div>

			<p className="text-xs text-muted-foreground mb-3">
				{t("rtk:settings.description")}
			</p>

			<div className="flex items-center justify-between py-2">
				<div>
					<span className="text-sm font-medium">{t("rtk:settings.enabled")}</span>
					<p className="text-xs text-muted-foreground">
						{t("rtk:settings.enabledHint")}
					</p>
				</div>
				<Switch
					checked={enabled}
					onCheckedChange={(checked) => onUpdate("rtkEnabled", checked)}
				/>
			</div>

			<div className="flex items-center justify-between py-2">
				<div>
					<span className="text-sm font-medium">
						{t("rtk:settings.modelFacing")}
					</span>
					<p className="text-xs text-muted-foreground">
						{t("rtk:settings.modelFacingHint")}
					</p>
				</div>
				<Switch
					checked={enabled && tokenSavings?.rtkModelFacing !== false}
					disabled={!enabled}
					onCheckedChange={(checked) => onUpdate("rtkModelFacing", checked)}
				/>
			</div>

			{!installed && (
				<p className="mt-2 text-xs text-muted-foreground">
					{t("rtk:settings.notInstalled")}{" "}
					<code className="rounded bg-muted px-1 py-0.5">brew install rtk</code>{" "}
					<a
						href="https://github.com/rtk-ai/rtk"
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 underline"
					>
						{t("rtk:settings.learnMore")}
						<ExternalLink className="h-3 w-3" aria-hidden />
					</a>
				</p>
			)}

			{installed && !terminalHook && (
				<p className="mt-2 text-xs text-muted-foreground">
					{t("rtk:settings.terminalHook")}{" "}
					<code className="rounded bg-muted px-1 py-0.5">rtk init -g</code>
				</p>
			)}
		</div>
	);
}
