import type { WorktreeDiffAttribution, WorktreeDiffFile } from "@shared/types";
import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sharePercent } from "../../../../shared/utils/agent-trace";
import { Badge } from "../../ui/badge";

/**
 * La part des lignes ajoutées qu'un agent a écrites (Agent Trace, F3), lue
 * dans le registre que le build tient à chaque session. Rien n'est affiché
 * quand la tâche n'en a pas.
 */
export function AiFileShare({ file }: { readonly file: WorktreeDiffFile }) {
	const { t } = useTranslation("taskReview");
	const a = file.attribution;
	if (!a || a.added <= 0) return null;
	const ai = sharePercent(a.ai, a.added);
	const title = t("diff.attribution.fileTitle", {
		ai,
		human: sharePercent(a.human, a.added),
		unknown: sharePercent(a.unknown, a.added),
	});
	return (
		<Badge variant="outline" className="text-xs gap-1" title={title} aria-label={title}>
			<Bot className="h-3 w-3" aria-hidden />
			{t("diff.attribution.fileBadge", { ai })}
		</Badge>
	);
}

export function AiTaskShare({
	attribution,
}: {
	readonly attribution?: WorktreeDiffAttribution;
}) {
	const { t } = useTranslation("taskReview");
	if (!attribution || attribution.added <= 0 || attribution.ai <= 0) return null;
	const models = Object.entries(attribution.models)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([model]) => model)
		.join(", ");
	return (
		<span className="flex items-center gap-1 text-xs text-muted-foreground">
			<Bot className="h-3 w-3" aria-hidden />
			{t(models ? "diff.attribution.taskWithModels" : "diff.attribution.task", {
				ai: sharePercent(attribution.ai, attribution.added),
				added: attribution.added,
				human: sharePercent(attribution.human, attribution.added),
				models,
			})}
		</span>
	);
}
