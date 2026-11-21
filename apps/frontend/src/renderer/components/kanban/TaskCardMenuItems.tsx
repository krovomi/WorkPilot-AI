import {
	ArrowRightLeft,
	Copy,
	ExternalLink,
	Flag,
	Gauge,
	GitMerge,
	Pause,
	Pencil,
	Play,
	Shapes,
	Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CardType } from "../../../shared/constants/card-types";
import { TASK_STATUS_LABELS } from "../../../shared/constants";
import type { TaskStatusColumn } from "../../../shared/constants/task";
import type { TaskPriority, TaskStatus } from "../../../shared/types";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { CardTypeMenuItems, PriorityMenuItems } from "./CardChoiceMenuItems";

export interface TaskCardMenuActions {
	/** Opens the card's panel (right-click menu only: a click does it too). */
	onOpen?: () => void;
	/** Opens the edit dialog. */
	onEdit?: () => void;
	onSetType?: (type: CardType) => void;
	onSetPriority?: (priority: TaskPriority) => void;
	/** The columns the card can be moved to by hand, and the move. */
	moves?: {
		targets: readonly TaskStatusColumn[];
		onMove: (status: TaskStatus) => void;
	};
	onEstimate?: () => void;
	onDuplicate?: () => void;
	onPause?: () => void;
	onResume?: () => void;
	onSyncFromBranch?: () => void;
	onDelete?: () => void;
}

interface TaskCardMenuItemsProps extends TaskCardMenuActions {
	currentType?: CardType | null;
	currentPriority?: TaskPriority | null;
	/** An agent is working on the card: what it reads is not edited under it. */
	isLocked?: boolean;
}

/**
 * Everything a person can do on one card, as menu items. The card's "⋮"
 * menu and its right-click menu both render this list, so an action added
 * here shows in both. Design: docs/architecture/kanban-quick-edit.md.
 */
export function TaskCardMenuItems({
	onOpen,
	onEdit,
	onSetType,
	onSetPriority,
	moves,
	onEstimate,
	onDuplicate,
	onPause,
	onResume,
	onSyncFromBranch,
	onDelete,
	currentType,
	currentPriority,
	isLocked,
}: TaskCardMenuItemsProps) {
	const { t } = useTranslation(["tasks"]);
	const hasMoves = !!moves && moves.targets.length > 0;
	const hasEditGroup = !!(onOpen || onEdit || onSetType || onSetPriority || hasMoves);
	const hasWorkGroup = !!(onEstimate || onDuplicate || onPause || onResume || onSyncFromBranch);

	return (
		<>
			{onOpen && (
				<DropdownMenuItem onSelect={onOpen}>
					<ExternalLink className="mr-2 h-4 w-4" />
					{t("tasks:kanban.cardMenu.open")}
				</DropdownMenuItem>
			)}
			{onEdit && (
				<DropdownMenuItem onSelect={onEdit} disabled={isLocked}>
					<Pencil className="mr-2 h-4 w-4" />
					{t("tasks:kanban.cardMenu.edit")}
				</DropdownMenuItem>
			)}
			{onSetType && (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger disabled={isLocked}>
						<Shapes className="mr-2 h-4 w-4" />
						{t("tasks:kanban.cardMenu.type")}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent
						className="max-h-80 w-56 overflow-y-auto"
						onClick={(e) => e.stopPropagation()}
					>
						<CardTypeMenuItems current={currentType} onSelect={onSetType} />
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			)}
			{onSetPriority && (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger disabled={isLocked}>
						<Flag className="mr-2 h-4 w-4" />
						{t("tasks:kanban.cardMenu.priority")}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent
						className="w-44"
						onClick={(e) => e.stopPropagation()}
					>
						<PriorityMenuItems
							current={currentPriority}
							onSelect={onSetPriority}
						/>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			)}
			{moves && hasMoves && (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<ArrowRightLeft className="mr-2 h-4 w-4" />
						{t("tasks:actions.moveTo")}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent
						className="w-48"
						onClick={(e) => e.stopPropagation()}
					>
						{moves.targets.map((status) => (
							<DropdownMenuItem key={status} onSelect={() => moves.onMove(status)}>
								{t(TASK_STATUS_LABELS[status])}
							</DropdownMenuItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			)}
			{hasEditGroup && hasWorkGroup && <DropdownMenuSeparator />}
			{onEstimate && (
				<DropdownMenuItem onSelect={onEstimate}>
					<Gauge className="mr-2 h-4 w-4" />
					{t("tasks:actions.estimate")}
				</DropdownMenuItem>
			)}
			{onDuplicate && (
				<DropdownMenuItem onSelect={onDuplicate}>
					<Copy className="mr-2 h-4 w-4" />
					{t("tasks:actions.duplicate")}
				</DropdownMenuItem>
			)}
			{onResume && (
				<DropdownMenuItem onSelect={onResume}>
					<Play className="mr-2 h-4 w-4" />
					{t("tasks:actions.resume")}
				</DropdownMenuItem>
			)}
			{onPause && (
				<DropdownMenuItem onSelect={onPause}>
					<Pause className="mr-2 h-4 w-4" />
					{t("tasks:actions.pause")}
				</DropdownMenuItem>
			)}
			{onSyncFromBranch && (
				<DropdownMenuItem onSelect={onSyncFromBranch}>
					<GitMerge className="mr-2 h-4 w-4" />
					{t("tasks:actions.syncFromBranch")}
				</DropdownMenuItem>
			)}
			{onDelete && (
				<>
					{(hasEditGroup || hasWorkGroup) && <DropdownMenuSeparator />}
					<DropdownMenuItem
						onSelect={onDelete}
						className="text-destructive focus:text-destructive"
					>
						<Trash2 className="mr-2 h-4 w-4" />
						{t("tasks:actions.delete")}
					</DropdownMenuItem>
				</>
			)}
		</>
	);
}
