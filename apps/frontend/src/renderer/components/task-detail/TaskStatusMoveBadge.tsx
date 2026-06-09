import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	TASK_STATUS_COLUMNS,
	TASK_STATUS_LABELS,
	type TaskStatusColumn,
} from "../../../shared/constants";
import type { Task, TaskStatus } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { Badge, type BadgeProps } from "../ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * Couleur de la pastille par colonne cible (design-system tokens).
 * Permet d'identifier visuellement la destination dans le menu "Déplacer vers".
 */
const STATUS_DOT_CLASS: Record<TaskStatusColumn, string> = {
	backlog: "bg-muted-foreground/60",
	queue: "bg-cyan-400",
	in_progress: "bg-info",
	ai_review: "bg-warning",
	human_review: "bg-purple-400",
	done: "bg-success",
};

interface TaskStatusMoveBadgeProps {
	readonly task: Task;
	readonly variant: BadgeProps["variant"];
	readonly isRunning: boolean;
	readonly onMove: (newStatus: TaskStatus) => void;
}

/**
 * Badge de statut interactif du header de la modale de détail.
 *
 * Affiche le statut courant et, au clic, propose de déplacer la tâche vers une
 * autre colonne du Kanban — équivalent du menu « Déplacer vers » des cartes,
 * mais intégré de façon discrète au badge existant (chevron + pastilles).
 */
export function TaskStatusMoveBadge({
	task,
	variant,
	isRunning,
	onMove,
}: TaskStatusMoveBadgeProps) {
	const { t } = useTranslation(["tasks"]);

	const targets = TASK_STATUS_COLUMNS.filter(
		(status) => status !== task.status,
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={t("tasks:modal.move.trigger")}
					className="group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					<Badge
						variant={variant}
						className={cn(
							"text-xs gap-1 cursor-pointer ring-1 ring-transparent transition-all group-hover:ring-border group-data-[state=open]:ring-border",
							task.status === "in_progress" && isRunning && "status-running",
						)}
					>
						{t(TASK_STATUS_LABELS[task.status])}
						<ChevronDown className="h-3 w-3 opacity-50 transition-all group-hover:opacity-90 group-data-[state=open]:rotate-180" />
					</Badge>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-[11rem]">
				<DropdownMenuLabel className="text-xs text-muted-foreground">
					{t("tasks:modal.move.label")}
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{targets.map((status) => (
					<DropdownMenuItem
						key={status}
						className="gap-2 cursor-pointer"
						onClick={() => onMove(status)}
					>
						<span
							className={cn(
								"h-2 w-2 shrink-0 rounded-full",
								STATUS_DOT_CLASS[status],
							)}
						/>
						{t(TASK_STATUS_LABELS[status])}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
