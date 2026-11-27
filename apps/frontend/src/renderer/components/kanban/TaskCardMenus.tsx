import { MoreVertical } from "lucide-react";
import { type SyntheticEvent, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	type CardType,
	cardTypeChoiceMetadata,
	resolveCardType,
} from "../../../shared/constants/card-types";
import type { Task, TaskPriority, TaskStatus } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { canMoveTaskTo, manualMoveTargets } from "../../lib/kanban-columns";
import { useAbandonRequestStore } from "../../stores/abandon-request-store";
import { extractTextFromHtml } from "../../lib/utils";
import { openSmartEstimation } from "../../stores/smart-estimation-store";
import { applyCardChoice, type CardChoice } from "../../lib/card-edits";
import { pauseTask, resumeAbandonedTask, resumeTask } from "../../stores/task-store";
import { TaskEditDialog } from "../TaskEditDialog";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { type MenuPoint, PointerMenu } from "./PointerMenu";
import { BoardSelectionContext } from "./board-selection-context";
import {
	SelectionMenuItems,
	type TaskCardMenuActions,
	TaskCardMenuItems,
} from "./TaskCardMenuItems";

const stop = (e: SyntheticEvent) => e.stopPropagation();

interface TaskCardMenusProps {
	task: Task;
	isRunning: boolean;
	/** An agent is working on the card: its text, type and priority wait. */
	isLocked: boolean;
	onOpen: () => void;
	onStatusChange?: (status: TaskStatus) => unknown;
	onDuplicate?: () => void;
	onDelete?: () => void;
	/** Opens "sync from branch"; left out when the card cannot be synced. */
	onSync?: () => void;
	contextMenuAt: MenuPoint | null;
	onContextMenuClose: () => void;
	editOpen: boolean;
	onEditOpenChange: (open: boolean) => void;
}

/**
 * The card's "⋮" menu, its right-click menu and its edit dialog. Both menus
 * show the same list (TaskCardMenuItems); the right-click one opens at the
 * pointer and adds "Open". Design: docs/architecture/kanban-quick-edit.md.
 */
export function TaskCardMenus({
	task,
	isRunning,
	isLocked,
	onOpen,
	onStatusChange,
	onDuplicate,
	onDelete,
	onSync,
	contextMenuAt,
	onContextMenuClose,
	editOpen,
	onEditOpenChange,
}: TaskCardMenusProps) {
	const { t } = useTranslation(["tasks"]);
	const prUrl = task.metadata?.prUrl;
	const isPaused = !!task.metadata?.paused?.enabled;
	const currentType = useMemo(
		() => resolveCardType(task.metadata)?.type ?? null,
		[task.metadata],
	);
	const currentPriority = task.metadata?.priority ?? null;
	// On a card of a selection of several, the right-click acts on them all.
	const selection = useContext(BoardSelectionContext);
	const inSelection =
		!!selection &&
		selection.selectedTaskIds.size > 1 &&
		selection.selectedTaskIds.has(task.id);

	const actions = useMemo((): TaskCardMenuActions => {
		const save = async (change: CardChoice, label: string) => {
			if ((await applyCardChoice([task], change, label)) === 0) return;
			toast({
				variant: "destructive",
				title: t("tasks:kanban.cardMenu.saveFailed"),
			});
		};
		return {
			onEdit: () => onEditOpenChange(true),
			onSetType: (type: CardType) => {
				if (type === currentType) return;
				void save(cardTypeChoiceMetadata(type), t("tasks:kanban.undoLabels.type"));
			},
			onSetPriority: (priority: TaskPriority) =>
				void save({ priority }, t("tasks:kanban.undoLabels.priority")),
			moves: onStatusChange && {
				targets: manualMoveTargets({
					status: task.status,
					reviewReason: task.reviewReason,
					metadata: { prUrl, abandoned: task.metadata?.abandoned },
				}),
				onMove: (status) => void onStatusChange(status),
			},
			// A description with no text (empty, or only markup) says less
			// than the title.
			onEstimate: () =>
				openSmartEstimation(
					extractTextFromHtml(task.description) || task.title,
					task.id,
				),
			onDuplicate,
			onPause: isRunning && !isPaused ? () => void pauseTask(task.id) : undefined,
			onResume: isPaused ? () => void resumeTask(task.id) : undefined,
			onSyncFromBranch: onSync,
			onAbandon: canMoveTaskTo(task, "abandoned")
				? () => useAbandonRequestStore.getState().request([task.id])
				: undefined,
			onUnabandon:
				task.metadata?.abandoned === true ? () => void resumeAbandonedTask(task.id) : undefined,
			onDelete,
		};
	}, [
		task,
		prUrl,
		isRunning,
		isPaused,
		currentType,
		onStatusChange,
		onDuplicate,
		onDelete,
		onSync,
		onEditOpenChange,
		t,
	]);

	const itemProps = { ...actions, currentType, currentPriority, isLocked };

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						onClick={stop}
						onPointerDown={stop}
						aria-label={t("tasks:actions.taskActions")}
					>
						<MoreVertical className="h-4 w-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<TaskCardMenuItems {...itemProps} />
				</DropdownMenuContent>
			</DropdownMenu>

			{contextMenuAt && (
				<PointerMenu
					at={contextMenuAt}
					onClose={onContextMenuClose}
					label={t("tasks:kanban.cardMenu.label")}
				>
					{selection && inSelection ? (
						<SelectionMenuItems
							count={selection.selectedTaskIds.size}
							onSetType={selection.onSetType}
							onSetPriority={selection.onSetPriority}
							onDelete={selection.onDelete}
							onClear={selection.onClear}
						/>
					) : (
						<TaskCardMenuItems onOpen={onOpen} {...itemProps} />
					)}
				</PointerMenu>
			)}

			{editOpen && (
				<TaskEditDialog
					task={task}
					open={editOpen}
					onOpenChange={onEditOpenChange}
				/>
			)}
		</>
	);
}
