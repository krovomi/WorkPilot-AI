import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { Badge } from "../ui/badge";

/**
 * Who created a card an automation rule made: the board says « Automations »
 * (on a server project, the server's service account of that name), and the
 * rule's name on hover. See docs/architecture/automations.md.
 */
export function AutomationBadge({ task }: { readonly task: Task }) {
	const { t } = useTranslation("tasks");
	const origin = task.metadata?.automation;
	if (!origin) return null;
	return (
		<Badge
			variant="outline"
			className="text-[10px] px-1.5 py-0.5 flex w-fit items-center gap-1 bg-muted/40 text-muted-foreground border-border"
			title={t("labels.automationTooltip", { rule: origin.ruleName })}
		>
			<Bot className="h-3 w-3" aria-hidden />
			{t("labels.automation")}
		</Badge>
	);
}
