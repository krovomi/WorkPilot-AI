import {
	Ban,
	CheckCheck,
	ChevronLeft,
	ChevronRight,
	ChevronsRight,
	Flag,
	GitPullRequest,
	Shapes,
	Trash2,
	type LucideIcon,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CardType } from "../../../shared/constants/card-types";
import type { TaskStatusColumn } from "../../../shared/constants/task";
import type { TaskPriority } from "../../../shared/types";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { CardTypeMenuItems, PriorityMenuItems } from "./CardChoiceMenuItems";

type BulkStep =
	| { kind: "move"; to: TaskStatusColumn; icon: LucideIcon; primary: boolean }
	| { kind: "markDone" }
	| { kind: "createPRs" };

const back = (to: TaskStatusColumn): BulkStep => ({
	kind: "move",
	to,
	icon: ChevronLeft,
	primary: false,
});
const forward = (to: TaskStatusColumn): BulkStep => ({
	kind: "move",
	to,
	icon: ChevronsRight,
	primary: true,
});

/**
 * What the bar offers for a selection in one column, as the pipeline allows
 * it (VALID_BULK_TRANSITIONS): the secondary step, then the main one.
 */
const STEPS: Partial<Record<TaskStatusColumn, readonly BulkStep[]>> = {
	backlog: [
		{ kind: "move", to: "queue", icon: ChevronRight, primary: false },
		forward("in_progress"),
	],
	queue: [back("backlog"), forward("in_progress")],
	in_progress: [back("queue"), forward("ai_review")],
	ai_review: [back("in_progress"), forward("human_review")],
	human_review: [back("ai_review"), { kind: "markDone" }],
	done: [{ kind: "createPRs" }],
};

interface BulkActionBarProps {
	count: number;
	/** The column every selected card is in; null for a mixed selection. */
	column: TaskStatusColumn | null;
	onMove: (status: TaskStatusColumn) => void;
	onMarkDone: () => void;
	onCreatePRs: () => void;
	onSetType: (type: CardType) => void;
	onSetPriority: (priority: TaskPriority) => void;
	onDelete: () => void;
	onClear: () => void;
}

/**
 * The bar under the board while cards are selected: move, type, priority,
 * delete, clear. Design: docs/architecture/kanban-quick-edit.md.
 */
export function BulkActionBar({
	count,
	column,
	onMove,
	onMarkDone,
	onCreatePRs,
	onSetType,
	onSetPriority,
	onDelete,
	onClear,
}: BulkActionBarProps) {
	const { t } = useTranslation(["tasks"]);
	const steps = column ? (STEPS[column] ?? []) : [];

	return (
		<div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
			<div
				role="toolbar"
				aria-label={t("tasks:kanban.bulk.label")}
				className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-border bg-card shadow-lg backdrop-blur-sm"
			>
				<span className="text-sm font-medium text-foreground">
					{t("tasks:kanban.selectedCountOther", { count })}
				</span>
				<div className="w-px h-5 bg-border" />

				{column === null && (
					<span className="text-xs text-muted-foreground flex items-center gap-1.5">
						<Ban className="h-3.5 w-3.5" />
						{t("tasks:kanban.mixedColumnWarning")}
					</span>
				)}
				{steps.map((step) => {
					if (step.kind === "markDone") {
						return (
							<Button key="markDone" size="sm" className="gap-2" onClick={onMarkDone}>
								<CheckCheck className="h-4 w-4" />
								{t("tasks:kanban.markAsDone")}
							</Button>
						);
					}
					if (step.kind === "createPRs") {
						return (
							<Button key="createPRs" size="sm" className="gap-2" onClick={onCreatePRs}>
								<GitPullRequest className="h-4 w-4" />
								{t("tasks:kanban.createPRs")}
							</Button>
						);
					}
					const Icon = step.icon;
					return (
						<Button
							key={step.to}
							variant={step.primary ? "default" : "outline"}
							size="sm"
							className="gap-2"
							onClick={() => onMove(step.to)}
						>
							<Icon className="h-4 w-4" />
							{t(`tasks:columns.${step.to}`)}
						</Button>
					);
				})}

				<div className="w-px h-5 bg-border" />
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm" className="gap-2">
							<Shapes className="h-4 w-4" />
							{t("tasks:kanban.cardMenu.type")}
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" className="max-h-80 w-56 overflow-y-auto">
						<CardTypeMenuItems onSelect={onSetType} />
					</DropdownMenuContent>
				</DropdownMenu>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm" className="gap-2">
							<Flag className="h-4 w-4" />
							{t("tasks:kanban.cardMenu.priority")}
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" className="w-44">
						<PriorityMenuItems onSelect={onSetPriority} />
					</DropdownMenuContent>
				</DropdownMenu>
				<Button
					variant="ghost"
					size="sm"
					className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
					onClick={onDelete}
				>
					<Trash2 className="h-4 w-4" />
					{t("tasks:kanban.deleteSelected")}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="gap-2 text-muted-foreground hover:text-foreground"
					onClick={onClear}
				>
					<X className="h-4 w-4" />
					{t("tasks:kanban.clearSelection")}
				</Button>
			</div>
		</div>
	);
}
