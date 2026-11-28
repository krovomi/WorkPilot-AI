import { PowerOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { formatAppDateTime } from "../../lib/date-format";
import type { CardInterruption } from "../../lib/interrupted-task";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/**
 * « Interrompue » on a card the app interrupted: WorkPilot closed, or stopped
 * without closing, while the build ran. Never « Bloquée »: nothing is wrong
 * with the build, Reprendre picks it back up where it stopped.
 */
export function InterruptedBadge({
	task,
	origin,
}: {
	readonly task: Task;
	readonly origin: CardInterruption;
}) {
	const { t } = useTranslation(["tasks"]);
	const at = task.metadata?.paused?.paused_at;
	const when = at && !Number.isNaN(Date.parse(at)) ? formatAppDateTime(new Date(at)) : null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge
					variant="outline"
					data-testid="task-interrupted-badge"
					className={cn(
						"text-3xs px-1.5 py-0.5 flex items-center gap-1",
						origin === "crash"
							? "bg-warning/10 text-warning border-warning/30"
							: "bg-info/10 text-info border-info/30",
					)}
				>
					<PowerOff className="h-2.5 w-2.5" />
					{t("tasks:labels.interrupted")}
				</Badge>
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-xs text-xs">
				{when
					? t(`tasks:interrupted.card.${origin}WithTime`, { when })
					: t(`tasks:interrupted.card.${origin}`)}
			</TooltipContent>
		</Tooltip>
	);
}
