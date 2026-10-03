import type { ProjectEnvConfig } from "@shared/types";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Switch } from "../ui/switch";

/**
 * ui-ux-pro-max dans les réglages — l'endroit où on le découvre et où on le coupe.
 *
 * La carte du Kanban ne s'affiche que sur une tâche qui touche l'interface ;
 * ici la section est toujours visible. Il n'y a rien à installer : le skill est
 * vendorisé dans WorkPilot et son moteur tourne avec le Python du backend.
 *
 * Deux décisions séparées. La première dit si le design system est utilisé du
 * tout ; la seconde s'il peut être écrit dans le dépôt du projet
 * (`design-system/<projet>/MASTER.md`), ce qui touche au diff de la tâche.
 */
export function UiUxSettings({
	uiux,
	onUpdate,
}: {
	uiux: ProjectEnvConfig["uiux"];
	onUpdate: (
		key: keyof NonNullable<ProjectEnvConfig["uiux"]>,
		value: boolean,
	) => void;
}) {
	const { t } = useTranslation(["settings"]);
	const enabled = uiux?.enabled !== false;

	return (
		<div className="pt-4 border-t border-border">
			<div className="flex items-center gap-2 mb-3">
				<Palette className="h-3 w-3 text-muted-foreground" aria-hidden />
				<span className="text-xs text-muted-foreground uppercase tracking-wider">
					{t("settings:uiux.title")}
				</span>
			</div>

			<p className="text-xs text-muted-foreground mb-3">
				{t("settings:uiux.description")}
			</p>

			<div className="flex items-center justify-between py-2">
				<div>
					<span className="text-sm font-medium">{t("settings:uiux.enabled")}</span>
					<p className="text-xs text-muted-foreground">
						{t("settings:uiux.enabledHint")}
					</p>
				</div>
				<Switch
					checked={enabled}
					onCheckedChange={(checked) => onUpdate("enabled", checked)}
					aria-label={t("settings:uiux.enabled")}
				/>
			</div>

			<div className="flex items-center justify-between py-2">
				<div>
					<span className="text-sm font-medium">
						{t("settings:uiux.persistMaster")}
					</span>
					<p className="text-xs text-muted-foreground">
						{t("settings:uiux.persistMasterHint")}
					</p>
				</div>
				<Switch
					checked={enabled && uiux?.persistMaster !== false}
					disabled={!enabled}
					onCheckedChange={(checked) => onUpdate("persistMaster", checked)}
					aria-label={t("settings:uiux.persistMaster")}
				/>
			</div>
		</div>
	);
}
