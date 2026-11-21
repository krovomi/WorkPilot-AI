import {
	Archive,
	CheckSquare,
	ChevronLeft,
	Eye,
	ListPlus,
	Lock,
	Plus,
	Settings,
	Unlock,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";

export interface ColumnMenuActions {
	/** Opens the column's quick-add box. */
	onAddCard?: () => void;
	/** Select all, or deselect all when every card is selected. */
	onToggleSelectAll?: () => void;
	isAllSelected?: boolean;
	onQueueAll?: () => void;
	onQueueSettings?: () => void;
	onArchiveAll?: () => void;
	onToggleArchived?: () => void;
	showArchived?: boolean;
	onToggleLocked?: () => void;
	isLocked?: boolean;
	onToggleCollapsed?: () => void;
}

/** True when the column menu would show at least one item. */
export function hasColumnMenuItems(actions: ColumnMenuActions): boolean {
	return !!(
		actions.onAddCard ||
		actions.onToggleSelectAll ||
		actions.onQueueAll ||
		actions.onQueueSettings ||
		actions.onArchiveAll ||
		actions.onToggleArchived ||
		actions.onToggleLocked ||
		actions.onToggleCollapsed
	);
}

/**
 * Everything a person can do on one column, as menu items: the column's
 * "⋯" menu and its right-click menu both render this list. Each action is
 * left out by the column when it does not apply (no cards, wrong column).
 */
export function ColumnMenuItems({
	onAddCard,
	onToggleSelectAll,
	isAllSelected,
	onQueueAll,
	onQueueSettings,
	onArchiveAll,
	onToggleArchived,
	showArchived,
	onToggleLocked,
	isLocked,
	onToggleCollapsed,
}: ColumnMenuActions) {
	const { t } = useTranslation(["tasks", "common"]);
	const hasCardGroup = !!(
		onAddCard ||
		onToggleSelectAll ||
		onQueueAll ||
		onArchiveAll ||
		onToggleArchived
	);
	const hasColumnGroup = !!(onQueueSettings || onToggleLocked || onToggleCollapsed);

	return (
		<>
			{onAddCard && (
				<DropdownMenuItem onSelect={onAddCard}>
					<Plus className="mr-2 h-4 w-4" />
					{t("tasks:kanban.quickAdd.addCard")}
				</DropdownMenuItem>
			)}
			{onToggleSelectAll && (
				<DropdownMenuItem onSelect={onToggleSelectAll}>
					<CheckSquare className="mr-2 h-4 w-4" />
					{isAllSelected ? t("tasks:kanban.deselectAll") : t("tasks:kanban.selectAll")}
				</DropdownMenuItem>
			)}
			{onQueueAll && (
				<DropdownMenuItem onSelect={onQueueAll}>
					<ListPlus className="mr-2 h-4 w-4" />
					{t("tasks:queue.queueAll")}
				</DropdownMenuItem>
			)}
			{onArchiveAll && (
				<DropdownMenuItem onSelect={onArchiveAll}>
					<Archive className="mr-2 h-4 w-4" />
					{t("tasks:tooltips.archiveAllDone")}
				</DropdownMenuItem>
			)}
			{onToggleArchived && (
				<DropdownMenuItem onSelect={onToggleArchived}>
					<Eye className="mr-2 h-4 w-4" />
					{showArchived
						? t("common:projectTab.hideArchived")
						: t("common:projectTab.showArchived")}
				</DropdownMenuItem>
			)}
			{hasCardGroup && hasColumnGroup && <DropdownMenuSeparator />}
			{onQueueSettings && (
				<DropdownMenuItem onSelect={onQueueSettings}>
					<Settings className="mr-2 h-4 w-4" />
					{t("tasks:kanban.queueSettings")}
				</DropdownMenuItem>
			)}
			{onToggleLocked && (
				<DropdownMenuItem onSelect={onToggleLocked}>
					{isLocked ? (
						<Unlock className="mr-2 h-4 w-4" />
					) : (
						<Lock className="mr-2 h-4 w-4" />
					)}
					{isLocked ? t("tasks:kanban.unlockColumn") : t("tasks:kanban.lockColumn")}
				</DropdownMenuItem>
			)}
			{onToggleCollapsed && (
				<DropdownMenuItem onSelect={onToggleCollapsed}>
					<ChevronLeft className="mr-2 h-4 w-4" />
					{t("tasks:kanban.collapseColumn")}
				</DropdownMenuItem>
			)}
		</>
	);
}
