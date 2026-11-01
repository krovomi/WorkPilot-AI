/**
 * One Kanban column: the droppable list, its header and WIP-limit popover, the
 * sortable wrapper, and the memo comparators the board's render cost depends on.
 * Split out of KanbanBoard.tsx (audit lot L11, F36).
 */

import { type DraggableAttributes, useDroppable } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	Archive,
	Ban,
	Check,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	Eye,
	Gauge,
	GripVertical,
	Inbox,
	ListPlus,
	Loader2,
	Lock,
	MoreHorizontal,
	Plus,
	Settings,
	Unlock,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TASK_STATUS_LABELS } from "../../../shared/constants";
import type { Task, TaskStatus } from "../../../shared/types";
import { cn } from "../../lib/utils";
import {
	COLLAPSED_COLUMN_WIDTH,
	DEFAULT_COLUMN_WIDTH,
	MAX_COLUMN_WIDTH,
	MIN_COLUMN_WIDTH,
} from "../../stores/kanban-settings-store";
import { SortableTaskCard } from "../SortableTaskCard";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Max cards a single column renders before collapsing the tail behind a
// "show more" toggle. Huge columns (e.g. a freshly bulk-imported backlog)
// otherwise mount hundreds of cards and jank the board. Capping keeps the DOM
// bounded while reusing the exact same (drag-enabled) render path for the
// visible slice — no change to drag-and-drop behaviour.
export const COLUMN_RENDER_CAP = 60;

export interface DroppableColumnProps {
	status: TaskStatus;
	tasks: Task[];
	onTaskClick: (task: Task) => void;
	onStatusChange: (taskId: string, newStatus: TaskStatus) => unknown;
	isOver: boolean;
	isImportForbidden?: boolean;
	onAddClick?: () => void;
	onArchiveAll?: () => void;
	onQueueSettings?: () => void;
	onQueueAll?: () => void;
	maxParallelTasks?: number;
	/** Soft WIP limit for this column (undefined = no limit). */
	wipLimit?: number;
	/** Set or clear (undefined) the soft WIP limit for this column. */
	onSetWipLimit?: (limit: number | undefined) => void;
	archivedCount?: number;
	showArchived?: boolean;
	onToggleArchived?: () => void;
	// Selection props for human_review column
	selectedTaskIds?: Set<string>;
	onSelectAll?: () => void;
	onDeselectAll?: () => void;
	onToggleSelect?: (taskId: string) => void;
	onDeleteTask?: (taskId: string) => void;
	onDuplicateTask?: (taskId: string) => void;
	onViewPRFiles?: (prUrl: string, taskId: string) => void;
	onPreviewApp?: (taskId: string) => void;
	// Collapse props
	isCollapsed?: boolean;
	onToggleCollapsed?: () => void;
	// Resize props
	columnWidth?: number;
	isResizing?: boolean;
	onResizeStart?: (startX: number) => void;
	onResizeEnd?: () => void;
	// Lock props
	isLocked?: boolean;
	onToggleLocked?: () => void;
	// Column drag handle props (for column reordering)
	dragHandleProps?: {
		listeners: SyntheticListenerMap | undefined;
		attributes: DraggableAttributes;
	};
}

/**
 * Compare two tasks arrays for meaningful changes.
 * Returns true if tasks are equivalent (should skip re-render).
 */
export function tasksAreEquivalent(prevTasks: Task[], nextTasks: Task[]): boolean {
	if (prevTasks.length !== nextTasks.length) return false;
	if (prevTasks === nextTasks) return true;

	// Compare by ID and fields that affect rendering
	for (let i = 0; i < prevTasks.length; i++) {
		const prev = prevTasks[i];
		const next = nextTasks[i];
		if (
			prev.id !== next.id ||
			prev.status !== next.status ||
			prev.executionProgress?.phase !== next.executionProgress?.phase ||
			prev.updatedAt !== next.updatedAt
		) {
			return false;
		}
	}
	return true;
}

/**
 * Custom comparator for DroppableColumn memo.
 */
export function droppableColumnPropsAreEqual(
	prevProps: DroppableColumnProps,
	nextProps: DroppableColumnProps,
): boolean {
	// Quick checks first
	if (prevProps.status !== nextProps.status) return false;
	if (prevProps.isOver !== nextProps.isOver) return false;
	if (prevProps.isImportForbidden !== nextProps.isImportForbidden) return false;
	if (prevProps.onTaskClick !== nextProps.onTaskClick) return false;
	if (prevProps.onStatusChange !== nextProps.onStatusChange) return false;
	if (prevProps.onAddClick !== nextProps.onAddClick) return false;
	if (prevProps.onArchiveAll !== nextProps.onArchiveAll) return false;
	if (prevProps.onQueueSettings !== nextProps.onQueueSettings) return false;
	if (prevProps.onQueueAll !== nextProps.onQueueAll) return false;
	if (prevProps.maxParallelTasks !== nextProps.maxParallelTasks) return false;
	if (prevProps.wipLimit !== nextProps.wipLimit) return false;
	if (prevProps.onSetWipLimit !== nextProps.onSetWipLimit) return false;
	if (prevProps.archivedCount !== nextProps.archivedCount) return false;
	if (prevProps.showArchived !== nextProps.showArchived) return false;
	if (prevProps.onToggleArchived !== nextProps.onToggleArchived) return false;
	if (prevProps.onSelectAll !== nextProps.onSelectAll) return false;
	if (prevProps.onDeselectAll !== nextProps.onDeselectAll) return false;
	if (prevProps.onToggleSelect !== nextProps.onToggleSelect) return false;
	if (prevProps.isCollapsed !== nextProps.isCollapsed) return false;
	if (prevProps.columnWidth !== nextProps.columnWidth) return false;
	if (prevProps.isResizing !== nextProps.isResizing) return false;
	if (prevProps.onResizeStart !== nextProps.onResizeStart) return false;
	if (prevProps.onResizeEnd !== nextProps.onResizeEnd) return false;
	if (prevProps.isLocked !== nextProps.isLocked) return false;
	if (prevProps.onToggleLocked !== nextProps.onToggleLocked) return false;
	if (prevProps.onViewPRFiles !== nextProps.onViewPRFiles) return false;
	if (prevProps.onPreviewApp !== nextProps.onPreviewApp) return false;
	if (prevProps.dragHandleProps !== nextProps.dragHandleProps) return false;

	// Compare selection props
	const prevSelected = prevProps.selectedTaskIds;
	const nextSelected = nextProps.selectedTaskIds;
	if (prevSelected !== nextSelected) {
		if (!prevSelected || !nextSelected) return false;
		if (prevSelected.size !== nextSelected.size) return false;
		for (const id of prevSelected) {
			if (!nextSelected.has(id)) return false;
		}
	}

	// Deep compare tasks
	const tasksEqual = tasksAreEquivalent(prevProps.tasks, nextProps.tasks);

	// Only log when re-rendering (reduces noise)
	if (globalThis.DEBUG && !tasksEqual) {
		// noop
	}

	return tasksEqual;
}

// Empty state content for each column
export const getEmptyStateContent = (
	status: TaskStatus,
	t: (key: string) => string,
): { icon: React.ReactNode; message: string; subtext?: string } => {
	switch (status) {
		case "backlog":
			return {
				icon: <Inbox className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyBacklog"),
				subtext: t("kanban.emptyBacklogHint"),
			};
		case "queue":
			return {
				icon: <Loader2 className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyQueue"),
				subtext: t("kanban.emptyQueueHint"),
			};
		case "in_progress":
			return {
				icon: <Loader2 className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyInProgress"),
				subtext: t("kanban.emptyInProgressHint"),
			};
		case "ai_review":
			return {
				icon: <Eye className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyAiReview"),
				subtext: t("kanban.emptyAiReviewHint"),
			};
		case "human_review":
			return {
				icon: <Eye className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyHumanReview"),
				subtext: t("kanban.emptyHumanReviewHint"),
			};
		case "build_failed":
			return {
				icon: <CheckCircle2 className="h-6 w-6 text-success/50" />,
				message: t("kanban.emptyBuildFailed"),
				subtext: t("kanban.emptyBuildFailedHint"),
			};
		case "done":
			return {
				icon: <CheckCircle2 className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyDone"),
				subtext: t("kanban.emptyDoneHint"),
			};
		default:
			return {
				icon: <Inbox className="h-6 w-6 text-muted-foreground/50" />,
				message: t("kanban.emptyDefault"),
			};
	}
};

export interface WipLimitPopoverProps {
	wipLimit?: number;
	onSetWipLimit: (limit: number | undefined) => void;
}

/**
 * Small popover to set or clear a column's soft WIP limit. Kept self-contained
 * so the memoized DroppableColumn only re-renders on the `wipLimit` value.
 */
export function WipLimitPopover({ wipLimit, onSetWipLimit }: WipLimitPopoverProps) {
	const { t } = useTranslation(["tasks"]);
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<string>(wipLimit ? String(wipLimit) : "");

	// Re-sync the input whenever the popover opens or the stored value changes.
	useEffect(() => {
		if (open) setDraft(wipLimit ? String(wipLimit) : "");
	}, [open, wipLimit]);

	const commit = useCallback(() => {
		const parsed = Number.parseInt(draft, 10);
		onSetWipLimit(
			Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined,
		);
		setOpen(false);
	}, [draft, onSetWipLimit]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip delayDuration={200}>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className={cn(
								"h-6 w-6 transition-colors",
								wipLimit
									? "text-primary bg-primary/10 hover:bg-primary/20"
									: "hover:bg-muted-foreground/10 hover:text-muted-foreground kanban-col-tool",
							)}
							aria-label={t("kanban.wipLimit.set")}
						>
							<Gauge className="h-3.5 w-3.5" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="left">
					{t("kanban.wipLimit.set")}
				</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-60 space-y-3 p-3">
				<div className="space-y-1">
					<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						{t("kanban.wipLimit.label")}
					</span>
					<p className="text-xs text-muted-foreground">
						{t("kanban.wipLimit.description")}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Input
						type="number"
						min={1}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") commit();
						}}
						placeholder={t("kanban.wipLimit.placeholder")}
						className="h-8"
						autoFocus
					/>
					<Button
						size="icon"
						className="h-8 w-8 shrink-0"
						onClick={commit}
						aria-label={t("kanban.wipLimit.set")}
					>
						<Check className="h-4 w-4" />
					</Button>
				</div>
				{wipLimit !== undefined && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-full text-xs text-muted-foreground hover:text-destructive"
						onClick={() => {
							onSetWipLimit(undefined);
							setOpen(false);
						}}
					>
						<X className="mr-1 h-3 w-3" />
						{t("kanban.wipLimit.clear")}
					</Button>
				)}
			</PopoverContent>
		</Popover>
	);
}

export const DroppableColumn = memo(function DroppableColumn({
	status,
	tasks,
	onTaskClick,
	onStatusChange,
	isOver,
	isImportForbidden,
	onAddClick,
	onArchiveAll,
	onQueueSettings,
	onQueueAll,
	maxParallelTasks,
	wipLimit,
	onSetWipLimit,
	archivedCount,
	showArchived,
	onToggleArchived,
	selectedTaskIds,
	onSelectAll,
	onDeselectAll,
	onToggleSelect,
	onDeleteTask,
	onDuplicateTask,
	onViewPRFiles,
	onPreviewApp,
	isCollapsed,
	onToggleCollapsed,
	columnWidth,
	isResizing,
	onResizeStart,
	onResizeEnd,
	isLocked,
	onToggleLocked,
	dragHandleProps,
}: DroppableColumnProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const { setNodeRef } = useDroppable({
		id: status,
	});

	// Calculate selection state for this column
	const taskCount = tasks.length;
	const columnSelectedCount = tasks.filter((t) =>
		selectedTaskIds?.has(t.id),
	).length;
	const isAllSelected = taskCount > 0 && columnSelectedCount === taskCount;
	const isSomeSelected =
		columnSelectedCount > 0 && columnSelectedCount < taskCount;

	// Determine checkbox checked state: true (all), 'indeterminate' (some), false (none)
	let selectAllCheckedState: boolean | "indeterminate";

	if (isAllSelected) {
		selectAllCheckedState = true;
	} else if (isSomeSelected) {
		selectAllCheckedState = "indeterminate";
	} else {
		selectAllCheckedState = false;
	}

	// Handle select all checkbox change
	const handleSelectAllChange = useCallback(() => {
		if (isAllSelected) {
			onDeselectAll?.();
		} else {
			onSelectAll?.();
		}
	}, [isAllSelected, onSelectAll, onDeselectAll]);

	// Render cap: a very large column only mounts its first COLUMN_RENDER_CAP
	// cards until the user opts to reveal the rest. The common case (columns
	// under the cap) is byte-for-byte the previous behaviour.
	const [showAllCards, setShowAllCards] = useState(false);
	const visibleTasks = useMemo(
		() =>
			showAllCards || tasks.length <= COLUMN_RENDER_CAP
				? tasks
				: tasks.slice(0, COLUMN_RENDER_CAP),
		[tasks, showAllCards],
	);
	const hiddenCardCount = tasks.length - visibleTasks.length;

	// Memoize taskIds to prevent SortableContext from re-rendering unnecessarily
	const taskIds = useMemo(() => visibleTasks.map((t) => t.id), [visibleTasks]);

	// Create stable onClick handlers for each task to prevent unnecessary re-renders
	const onClickHandlers = useMemo(() => {
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onTaskClick(task));
		});
		return handlers;
	}, [tasks, onTaskClick]);

	// Create stable onStatusChange handlers for each task
	const onStatusChangeHandlers = useMemo(() => {
		const handlers = new Map<string, (newStatus: TaskStatus) => unknown>();
		tasks.forEach((task) => {
			handlers.set(task.id, (newStatus: TaskStatus) =>
				onStatusChange(task.id, newStatus),
			);
		});
		return handlers;
	}, [tasks, onStatusChange]);

	// Create stable onToggleSelect handlers for each task (for bulk selection)
	const onToggleSelectHandlers = useMemo(() => {
		if (!onToggleSelect) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onToggleSelect(task.id));
		});
		return handlers;
	}, [tasks, onToggleSelect]);

	// Create stable onDelete handlers for each task
	const onDeleteHandlers = useMemo(() => {
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onDeleteTask?.(task.id));
		});
		return handlers;
	}, [tasks, onDeleteTask]);

	// Create stable onDuplicate handlers for each task
	const onDuplicateHandlers = useMemo(() => {
		if (!onDuplicateTask) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onDuplicateTask(task.id));
		});
		return handlers;
	}, [tasks, onDuplicateTask]);

	// Create stable onViewPRFiles handlers for each task
	const onViewPRFilesHandlers = useMemo(() => {
		if (!onViewPRFiles) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => {
				if (task.metadata?.prUrl) {
					onViewPRFiles(task.metadata.prUrl, task.id);
				}
			});
		});
		return handlers;
	}, [tasks, onViewPRFiles]);

	// Create stable onPreviewApp handlers for each task
	const onPreviewAppHandlers = useMemo(() => {
		if (!onPreviewApp) return null;
		const handlers = new Map<string, () => void>();
		tasks.forEach((task) => {
			handlers.set(task.id, () => onPreviewApp(task.id));
		});
		return handlers;
	}, [tasks, onPreviewApp]);

	// Memoize task card elements to prevent recreation on every render
	const taskCards = useMemo(() => {
		if (tasks.length === 0) return null;
		const isSelectable = !!onToggleSelectHandlers;
		const cards: React.ReactNode[] = visibleTasks.map((task) => (
			<SortableTaskCard
				key={task.id}
				task={task}
				// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
				onClick={onClickHandlers.get(task.id)!}
				onStatusChange={onStatusChangeHandlers.get(task.id)}
				isSelectable={isSelectable}
				isSelected={isSelectable ? selectedTaskIds?.has(task.id) : undefined}
				onToggleSelect={onToggleSelectHandlers?.get(task.id)}
				onDelete={onDeleteHandlers.get(task.id)}
				onDuplicate={onDuplicateHandlers?.get(task.id)}
				onViewPRFiles={onViewPRFilesHandlers?.get(task.id)}
				onPreviewApp={onPreviewAppHandlers?.get(task.id)}
			/>
		));
		// "Show more / less" toggle for capped columns (expanded columns only —
		// the collapsed strip is a glance preview). It's not a sortable item, so
		// it sits inside SortableContext harmlessly.
		if (!isCollapsed && tasks.length > COLUMN_RENDER_CAP) {
			cards.push(
				<button
					key="__show_more_toggle__"
					type="button"
					onClick={() => setShowAllCards((v) => !v)}
					className="w-full rounded-md border border-dashed border-border/60 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
				>
					{showAllCards
						? t("kanban.showLess")
						: t("kanban.showMore", { count: hiddenCardCount })}
				</button>,
			);
		}
		return cards;
	}, [
		visibleTasks,
		tasks.length,
		isCollapsed,
		showAllCards,
		hiddenCardCount,
		t,
		onClickHandlers,
		onStatusChangeHandlers,
		onToggleSelectHandlers,
		onDeleteHandlers,
		onDuplicateHandlers,
		onViewPRFilesHandlers,
		onPreviewAppHandlers,
		selectedTaskIds,
	]);

	const getColumnBorderColor = (): string => {
		switch (status) {
			case "backlog":
				return "column-backlog";
			case "queue":
				return "column-queue";
			case "in_progress":
				return "column-in-progress";
			case "ai_review":
				return "column-ai-review";
			case "human_review":
				return "column-human-review";
			case "done":
				return "column-done";
			default:
				return "border-t-muted-foreground/30";
		}
	};

	const emptyState = getEmptyStateContent(status, t);

	// Collapsed state: show narrow vertical strip with rotated title and task count
	if (isCollapsed) {
		return (
			<div
				ref={setNodeRef}
				className={cn(
					"kanban-column relative flex flex-col rounded-xl transition-colors duration-200",
					getColumnBorderColor(),
					isOver && "drop-zone-highlight",
					isImportForbidden && "border-destructive/60",
				)}
				style={{
					width: COLLAPSED_COLUMN_WIDTH,
					minWidth: COLLAPSED_COLUMN_WIDTH,
					maxWidth: COLLAPSED_COLUMN_WIDTH,
				}}
				data-column-status={status}
			>
				{isImportForbidden && (
					<div className="absolute inset-0 rounded-xl bg-destructive/15 flex items-center justify-center z-10 pointer-events-none">
						<Ban className="h-6 w-6 text-destructive/70" />
					</div>
				)}
				{/* Expand button at top */}
				<div className="flex justify-center p-2 border-b border-white/5">
					<Tooltip delayDuration={200}>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 hover:bg-primary/10 hover:text-primary transition-colors"
								onClick={onToggleCollapsed}
								aria-label={t("kanban.expandColumn")}
							>
								<ChevronRight className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="right">
							{t("kanban.expandColumn")}
						</TooltipContent>
					</Tooltip>
				</div>

				{/* Rotated title and task count */}
				<div className="flex-1 flex flex-col items-center justify-center">
					<div
						className="flex items-center gap-2 whitespace-nowrap"
						style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
					>
						<span className="column-count-badge">{tasks.length}</span>
						<h2 className="font-semibold text-sm text-foreground">
							{t(TASK_STATUS_LABELS[status])}
						</h2>
					</div>
				</div>

				{/* Task list */}
				<div className="flex-1 min-h-0">
					<ScrollArea className="h-full px-3 pb-3 pt-2">
						<SortableContext
							items={taskIds}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-3 min-h-0">
								{tasks.length === 0 ? (
									<div
										className={cn(
											"empty-column-dropzone flex flex-col items-center justify-center py-6",
											isOver && "active",
										)}
									>
										{isOver ? (
											<>
												<div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center mb-2">
													<Plus className="h-4 w-4 text-primary" />
												</div>
												<span className="text-sm font-medium text-primary">
													{t("kanban.dropHere")}
												</span>
											</>
										) : (
											<>
												{emptyState.icon}
												<span className="mt-2 text-sm font-medium text-muted-foreground/70">
													{emptyState.message}
												</span>
												{emptyState.subtext && (
													<span className="mt-0.5 text-xs text-muted-foreground/50">
														{emptyState.subtext}
													</span>
												)}
											</>
										)}
									</div>
								) : (
									taskCards
								)}
							</div>
						</SortableContext>
					</ScrollArea>
				</div>
			</div>
		);
	}

	return (
		<div
			className="relative flex shrink-0 h-full"
			style={{
				width: columnWidth || DEFAULT_COLUMN_WIDTH,
				minWidth: MIN_COLUMN_WIDTH,
				maxWidth: MAX_COLUMN_WIDTH,
			}}
		>
			<div
				ref={setNodeRef}
				className={cn(
					"kanban-column relative flex min-w-0 flex-1 flex-col rounded-xl transition-colors duration-200",
					getColumnBorderColor(),
					isOver && "drop-zone-highlight",
					isImportForbidden && "border-destructive/60",
				)}
				data-column-status={status}
			>
				{isImportForbidden && (
					<div className="absolute inset-0 rounded-xl bg-destructive/15 flex items-center justify-center z-10 pointer-events-none">
						<Ban className="h-10 w-10 text-destructive/70" />
					</div>
				)}
				{/* Column header — the name and the count always show; the tools
				    (reorder, collapse, select, lock, WIP…) appear when the pointer
				    or the keyboard focus is on the column, so a resting board reads
				    as six names and six numbers. State worth seeing (a locked
				    column, a partial selection) stays visible. */}
				<div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
					<div className="flex min-w-0 items-center gap-1.5">
						<span
							aria-hidden="true"
							className="kanban-column-dot h-2 w-2 shrink-0 rounded-full"
						/>
						<h2 className="truncate font-semibold text-sm text-foreground">
							{t(TASK_STATUS_LABELS[status])}
						</h2>
						{status === "in_progress" && maxParallelTasks ? (
							<span
								className={cn(
									"column-count-badge",
									tasks.length >= maxParallelTasks &&
										"bg-warning/20 text-warning border-warning/30",
								)}
							>
								{tasks.length}/{maxParallelTasks}
							</span>
						) : wipLimit ? (
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<span
										className={cn(
											"column-count-badge",
											tasks.length > wipLimit &&
												"bg-warning/20 text-warning border-warning/30",
										)}
									>
										{tasks.length}/{wipLimit}
									</span>
								</TooltipTrigger>
								{tasks.length > wipLimit && (
									<TooltipContent>
										{t("kanban.wipLimit.exceeded", {
											count: tasks.length,
											limit: wipLimit,
										})}
									</TooltipContent>
								)}
							</Tooltip>
						) : (
							<span className="column-count-badge">{tasks.length}</span>
						)}
					</div>
					<div className="flex shrink-0 items-center gap-0.5">
						{/* Select All checkbox for column */}
						{onSelectAll && onDeselectAll && (
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<div
										className={cn(
											"flex shrink-0 items-center",
											selectAllCheckedState === false && "kanban-col-tool",
										)}
									>
										<Checkbox
											checked={selectAllCheckedState}
											onCheckedChange={handleSelectAllChange}
											disabled={taskCount === 0}
											aria-label={
												isAllSelected
													? t("kanban.deselectAll")
													: t("kanban.selectAll")
											}
											className="mx-1.5 h-4 w-4"
										/>
									</div>
								</TooltipTrigger>
								<TooltipContent>
									{isAllSelected
										? t("kanban.deselectAll")
										: t("kanban.selectAll")}
								</TooltipContent>
							</Tooltip>
						)}
						{/* A locked column shows its lock, a click away from unlocking;
						    locking itself lives in the column menu. */}
						{onToggleLocked && isLocked && (
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className={cn(
											"h-6 w-6 transition-colors",
											isLocked
												? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
												: "hover:bg-muted-foreground/10 hover:text-muted-foreground kanban-col-tool",
										)}
										onClick={onToggleLocked}
										aria-pressed={isLocked}
										aria-label={
											isLocked
												? t("kanban.unlockColumn")
												: t("kanban.lockColumn")
										}
									>
										{isLocked ? (
											<Lock className="h-3.5 w-3.5" />
										) : (
											<Unlock className="h-3.5 w-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="left">
									{isLocked ? t("kanban.unlockColumn") : t("kanban.lockColumn")}
								</TooltipContent>
							</Tooltip>
						)}
						{/* Soft WIP limit setter (not shown on in_progress, which uses
						    the hard parallel-task limit instead) */}
						{onSetWipLimit && (
							<WipLimitPopover
								wipLimit={wipLimit}
								onSetWipLimit={onSetWipLimit}
							/>
						)}
						{status === "backlog" && onAddClick && (
									<Tooltip delayDuration={200}>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="h-6 w-6 hover:bg-primary/10 hover:text-primary transition-colors"
												onClick={onAddClick}
												aria-label={t("kanban.addTaskAriaLabel")}
											>
												<Plus className="h-4 w-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="left">
											{t("kanban.addTaskAriaLabel")}
										</TooltipContent>
									</Tooltip>
						)}
						{status === "queue" && onQueueSettings && (
							<Button
								variant="ghost"
								size="icon"
								className="h-6 w-6 hover:bg-cyan-500/10 hover:text-cyan-400 kanban-col-tool transition-colors"
								onClick={onQueueSettings}
								title={t("kanban.queueSettings")}
							>
								<Settings className="h-4 w-4" />
							</Button>
						)}
						{status === "done" &&
							onArchiveAll &&
							tasks.length > 0 &&
							!showArchived && (
								<Button
									variant="ghost"
									size="icon"
									className="h-6 w-6 hover:bg-muted-foreground/10 hover:text-muted-foreground kanban-col-tool transition-colors"
									onClick={onArchiveAll}
									aria-label={t("tooltips.archiveAllDone")}
								>
									<Archive className="h-4 w-4" />
								</Button>
							)}
						{status === "done" &&
							archivedCount !== undefined &&
							archivedCount > 0 &&
							onToggleArchived && (
								<Tooltip delayDuration={200}>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className={cn(
												"h-6 w-6 transition-colors relative",
												showArchived
													? "text-primary bg-primary/10 hover:bg-primary/20"
													: "hover:bg-muted-foreground/10 hover:text-muted-foreground",
											)}
											onClick={onToggleArchived}
											aria-pressed={showArchived}
											aria-label={t(
												"common:accessibility.toggleShowArchivedAriaLabel",
											)}
										>
											<Archive className="h-4 w-4" />
											<span className="absolute -top-1 -right-1 text-[10px] font-medium bg-muted rounded-full min-w-[14px] h-[14px] flex items-center justify-center">
												{archivedCount}
											</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{showArchived
											? t("common:projectTab.hideArchived")
											: t("common:projectTab.showArchived")}
									</TooltipContent>
								</Tooltip>
							)}
						{/* Column menu: width lock and collapse, rarely used, so out of
						    the header. */}
						{(onToggleLocked || onToggleCollapsed) && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-6 w-6 hover:bg-muted-foreground/10 hover:text-muted-foreground kanban-col-tool"
										aria-label={t("kanban.columnOptions")}
										title={t("kanban.columnOptions")}
									>
										<MoreHorizontal className="h-3.5 w-3.5" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{onToggleLocked && (
										<DropdownMenuItem onClick={onToggleLocked}>
											{isLocked ? (
												<Unlock className="mr-2 h-4 w-4" />
											) : (
												<Lock className="mr-2 h-4 w-4" />
											)}
											{isLocked
												? t("kanban.unlockColumn")
												: t("kanban.lockColumn")}
										</DropdownMenuItem>
									)}
									{status === "backlog" && onQueueAll && tasks.length > 0 && (
										<DropdownMenuItem onClick={onQueueAll}>
											<ListPlus className="mr-2 h-4 w-4" />
											{t("queue.queueAll")}
										</DropdownMenuItem>
									)}
									{onToggleCollapsed && (
										<DropdownMenuItem onClick={onToggleCollapsed}>
											<ChevronLeft className="mr-2 h-4 w-4" />
											{t("kanban.collapseColumn")}
										</DropdownMenuItem>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{/* Column drag handle for reordering */}
						{dragHandleProps && (
							<Tooltip delayDuration={400}>
								<TooltipTrigger asChild>
									<button
										type="button"
										className="h-6 w-4 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground kanban-col-tool touch-none"
										{...dragHandleProps.listeners}
										{...dragHandleProps.attributes}
										aria-label={t("kanban.dragColumn")}
									>
										<GripVertical className="h-4 w-4" />
									</button>
								</TooltipTrigger>
								<TooltipContent>{t("kanban.dragColumn")}</TooltipContent>
							</Tooltip>
						)}
					</div>
				</div>

				{/* Task list */}
				<div className="flex-1 min-h-0">
					<ScrollArea className="h-full px-2.5 pb-2.5 pt-1">
						<SortableContext
							items={taskIds}
							strategy={verticalListSortingStrategy}
						>
							<div className="space-y-2 min-h-0">
								{tasks.length === 0 ? (
									<div
										className={cn(
											"empty-column-dropzone flex flex-col items-center justify-center py-6",
											isOver && "active",
										)}
									>
										{isOver ? (
											<>
												<div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center mb-2">
													<Plus className="h-4 w-4 text-primary" />
												</div>
												<span className="text-sm font-medium text-primary">
													{t("kanban.dropHere")}
												</span>
											</>
										) : (
											<>
												<span className="opacity-60 [&>svg]:h-5 [&>svg]:w-5">
													{emptyState.icon}
												</span>
												<span className="mt-2 text-xs font-medium text-muted-foreground/80">
													{emptyState.message}
												</span>
												{emptyState.subtext && (
													<span className="mt-0.5 max-w-[22ch] text-[11px] leading-snug text-muted-foreground/50">
														{emptyState.subtext}
													</span>
												)}
											</>
										)}
									</div>
								) : (
									taskCards
								)}
							</div>
						</SortableContext>
					</ScrollArea>
				</div>
			</div>

			{/* Resize handle on right edge */}
			{onResizeStart && onResizeEnd && (
				// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
				// biome-ignore lint/a11y/noNoninteractiveElementInteractions: resize handle — drag interaction
				<div
					className={cn(
						"absolute right-0 top-0 bottom-0 w-1 touch-none z-10",
						"transition-colors duration-150",
						isLocked
							? "cursor-not-allowed bg-transparent"
							: "cursor-col-resize hover:bg-primary/40",
						isResizing && !isLocked && "bg-primary/60",
					)}
					onMouseDown={(e) => {
						e.preventDefault();
						// Don't start resize if column is locked
						if (isLocked) return;
						onResizeStart(e.clientX);
					}}
					onTouchStart={(e) => {
						e.preventDefault();
						// Don't start resize if column is locked
						if (isLocked) return;
						if (e.touches.length > 0) {
							onResizeStart(e.touches[0].clientX);
						}
					}}
					title={isLocked ? t("kanban.columnLocked") : undefined}
				>
					{/* Wider invisible hit area for easier grabbing */}
					<div className="absolute inset-y-0 -left-1 -right-1" />
				</div>
			)}
		</div>
	);
}, droppableColumnPropsAreEqual);

// ============================================
// SortableColumnWrapper — enables column drag-to-reorder
// ============================================

export interface SortableColumnWrapperProps
	extends Omit<
		React.ComponentProps<typeof DroppableColumn>,
		"dragHandleProps"
	> {
	sortableId: string;
}

export function SortableColumnWrapper({
	sortableId,
	...columnProps
}: SortableColumnWrapperProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortableId });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 50 : undefined,
		position: "relative",
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(isDragging && "opacity-50")}
		>
			<DroppableColumn
				{...columnProps}
				dragHandleProps={{ listeners, attributes }}
			/>
		</div>
	);
}
