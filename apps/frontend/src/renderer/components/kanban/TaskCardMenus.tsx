import { MoreVertical } from "lucide-react";
import { type SyntheticEvent, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	type CardType,
	cardTypeChoiceMetadata,
	resolveCardType,
} from "../../../shared/constants/card-types";
import type {
	Task,
	TaskMetadata,
	TaskPriority,
	TaskStatus,
} from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { manualMoveTargets } from "../../lib/kanban-columns";
import { extractTextFromHtml } from "../../lib/utils";
import { openSmartEstimation } from "../../stores/smart-estimation-store";
import {
	pauseTask,
	persistUpdateTask,
	resumeTask,
} from "../../stores/task-store";
import { TaskEditDialog } from "../TaskEditDialog";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { type MenuPoint, PointerMenu } from "./PointerMenu";
import { type TaskCardMenuActions, TaskCardMenuItems } from "./TaskCardMenuItems";

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

	const actions = useMemo((): TaskCardMenuActions => {
		const save = async (metadata: Partial<TaskMetadata>) => {
			if (await persistUpdateTask(task.id, { metadata })) return;
			toast({
				variant: "destructive",
				title: t("tasks:kanban.cardMenu.saveFailed"),
			});
		};
		return {
			onEdit: () => onEditOpenChange(true),
			onSetType: (type: CardType) => {
				if (type !== currentType) void save(cardTypeChoiceMetadata(type));
			},
			onSetPriority: (priority: TaskPriority) => {
				if (priority !== currentPriority) void save({ priority });
			},
			moves: onStatusChange && {
				targets: manualMoveTargets({ status: task.status, metadata: { prUrl } }),
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
			onDelete,
		};
	}, [
		task.id,
		task.status,
		task.description,
		task.title,
		prUrl,
		isRunning,
		isPaused,
		currentType,
		currentPriority,
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
					<TaskCardMenuItems onOpen={onOpen} {...itemProps} />
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
