import type { TaskLogPhase, TaskLogs } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { useTranslation } from "react-i18next";

interface TaskPhaseBarProps {
	phaseLogs: TaskLogs | null;
}

const PHASE_ORDER: TaskLogPhase[] = ["planning", "coding", "validation"];

const PHASE_STYLES: Record<
	TaskLogPhase,
	{ text: string; bg: string }
> = {
	planning: {
		text: "text-amber-600 dark:text-amber-400",
		bg: "bg-amber-500/10 border-b border-amber-500/30",
	},
	coding: {
		text: "text-info",
		bg: "bg-info/10 border-b border-info/30",
	},
	validation: {
		text: "text-purple-600 dark:text-purple-400",
		bg: "bg-purple-500/10 border-b border-purple-500/30",
	},
};

const PHASE_I18N_KEYS: Record<TaskLogPhase, string> = {
	planning: "execution.phases.planning",
	coding: "execution.phases.coding",
	validation: "execution.phases.validation",
};

export function TaskPhaseBar({ phaseLogs }: TaskPhaseBarProps) {
	const { t } = useTranslation("tasks");

	if (!phaseLogs) return null;

	const activePhase = PHASE_ORDER.find(
		(p) => phaseLogs.phases[p]?.status === "active",
	);

	if (!activePhase) return null;

	const phaseNumber = PHASE_ORDER.indexOf(activePhase) + 1;
	const styles = PHASE_STYLES[activePhase];

	return (
		<div
			className={cn(
				"flex items-center gap-2 px-5 py-1.5 shrink-0",
				styles.bg,
			)}
		>
			<span className={cn("text-xs font-medium", styles.text)}>
				{t(PHASE_I18N_KEYS[activePhase])}
			</span>
			<span className="text-xs text-muted-foreground">•</span>
			<span className="text-xs text-muted-foreground">
				Phase {phaseNumber}/{PHASE_ORDER.length}
			</span>
		</div>
	);
}
