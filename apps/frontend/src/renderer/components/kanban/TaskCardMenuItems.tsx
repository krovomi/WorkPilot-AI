import {
	ArrowRightLeft,
	Ban,
	Copy,
	ExternalLink,
	Flag,
	FlagOff,
	Gauge,
	GitMerge,
	IterationCw,
	Pause,
	Pencil,
	Play,
	Shapes,
	Tag,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CardType } from "../../../shared/constants/card-types";
import { TASK_STATUS_LABELS } from "../../../shared/constants";
import type { TaskPriority, TaskStatus } from "../../../shared/types";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { CardTypeMenuItems, PriorityMenuItems } from "./CardChoiceMenuItems";
import { SprintChoiceMenuItems } from "./SprintChoiceMenuItems";

export interface TaskCardMenuActions {
	/** Opens the card's panel (right-click menu only: a click does it too). */
	onOpen?: () => void;
	/** Opens the edit dialog. */
	onEdit?: () => void;
	onSetType?: (type: CardType) => void;
	onSetPriority?: (priority: TaskPriority) => void;
	/** Puts the card in a sprint, or back in the backlog (null). */
	onSetSprint?: (sprintId: string | null) => void;
	/** Opens the labels dialog (the board's labels: an agent's run neither reads nor changes them). */
	onEditLabels?: () => void;
	/** The columns the card can be moved to by hand, and the move. */
	moves?: {
		targets: readonly TaskStatus[];
		onMove: (status: TaskStatus) => void;
	};
	onEstimate?: () => void;
	onDuplicate?: () => void;
	onPause?: () => void;
	onResume?: () => void;
	onSyncFromBranch?: () => void;
	/** Flags the task « Bloquée » (asks why), or lifts the flag. */
	onFlag?: () => void;
	onUnflag?: () => void;
	/** Sets the task aside (asks why) or, when it is abandoned, resumes it. */
	onAbandon?: () => void;
	onUnabandon?: () => void;
	onDelete?: () => void;
}

interface TaskCardMenuItemsProps extends TaskCardMenuActions {
	currentType?: CardType | null;
	currentPriority?: TaskPriority | null;
	currentSprint?: string | null;
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
	onSetSprint,
	onEditLabels,
	moves,
	onEstimate,
	onDuplicate,
	onPause,
	onResume,
	onSyncFromBranch,
	onFlag,
	onUnflag,
	onAbandon,
	onUnabandon,
	onDelete,
	currentType,
	currentPriority,
	currentSprint,
	isLocked,
}: TaskCardMenuItemsProps) {
	const { t } = useTranslation(["tasks"]);
	const hasMoves = !!moves && moves.targets.length > 0;
	const hasEditGroup = !!(onOpen || onEdit || onSetType || onSetPriority || onSetSprint || onEditLabels || hasMoves);
	const hasWorkGroup = !!(
		onEstimate || onDuplicate || onPause || onResume || onSyncFromBranch || onFlag || onUnflag || onAbandon || onUnabandon
	);

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
			{onSetSprint && (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<IterationCw className="mr-2 h-4 w-4" />
						{t("tasks:kanban.sprints.cardMenu")}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-56" onClick={(e) => e.stopPropagation()}>
						<SprintChoiceMenuItems current={currentSprint} onSelect={onSetSprint} />
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			)}
			{onEditLabels && (
				<DropdownMenuItem onSelect={onEditLabels}>
					<Tag className="mr-2 h-4 w-4" />
					{t("tasks:cardLabels.cardMenu")}
				</DropdownMenuItem>
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
			{onFlag && (
				<DropdownMenuItem onSelect={onFlag}>
					<Flag className="mr-2 h-4 w-4 text-destructive" />
					{t("tasks:flag.flagMenu")}
				</DropdownMenuItem>
			)}
			{onUnflag && (
				<DropdownMenuItem onSelect={onUnflag}>
					<FlagOff className="mr-2 h-4 w-4" />
					{t("tasks:flag.unflag")}
				</DropdownMenuItem>
			)}
			{onAbandon && (
				<DropdownMenuItem onSelect={onAbandon}>
					<Ban className="mr-2 h-4 w-4" />
					{t("tasks:abandon.abandonMenu")}
				</DropdownMenuItem>
			)}
			{onUnabandon && (
				<DropdownMenuItem onSelect={onUnabandon}>
					<Undo2 className="mr-2 h-4 w-4" />
					{t("tasks:abandon.resume")}
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

interface SelectionMenuItemsProps {
	count: number;
	onSetType: (type: CardType) => void;
	onSetPriority: (priority: TaskPriority) => void;
	onDelete: () => void;
	onClear: () => void;
}

/**
 * The right-click menu of a card that is part of a selection of several:
 * it acts on every selected card.
 */
export function SelectionMenuItems({
	count,
	onSetType,
	onSetPriority,
	onDelete,
	onClear,
}: SelectionMenuItemsProps) {
	const { t } = useTranslation(["tasks"]);
	return (
		<>
			<DropdownMenuLabel>
				{t("tasks:kanban.selectedCountOther", { count })}
			</DropdownMenuLabel>
			<DropdownMenuSeparator />
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<Shapes className="mr-2 h-4 w-4" />
					{t("tasks:kanban.cardMenu.type")}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
					<CardTypeMenuItems onSelect={onSetType} />
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<Flag className="mr-2 h-4 w-4" />
					{t("tasks:kanban.cardMenu.priority")}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="w-44">
					<PriorityMenuItems onSelect={onSetPriority} />
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			<DropdownMenuItem onSelect={onClear}>
				<X className="mr-2 h-4 w-4" />
				{t("tasks:kanban.clearSelection")}
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem
				onSelect={onDelete}
				className="text-destructive focus:text-destructive"
			>
				<Trash2 className="mr-2 h-4 w-4" />
				{t("tasks:kanban.deleteSelected")}
			</DropdownMenuItem>
		</>
	);
}
