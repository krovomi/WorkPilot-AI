import { useCallback, useEffect, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
	type CardType,
	cardTypeChoiceMetadata,
} from "../../shared/constants/card-types";
import type { TaskStatusColumn } from "../../shared/constants/task";
import type { Task, TaskPriority } from "../../shared/types";
import { deleteCardsLater } from "../components/kanban/deleteCardsLater";
import { applyCardChoice, isLightCard, recordMoves } from "../lib/card-edits";
import { countRunning, type GroupMovePlan, planGroupMove } from "../lib/group-move";
import { getVisualColumn } from "../lib/kanban-columns";
import { undoLast, useBoardUndoStore } from "../stores/board-undo-store";
import { persistTaskStatus, useTaskStore } from "../stores/task-store";
import { toast } from "./use-toast";

/** What a group move did besides moving: cards left waiting, cards left in place. */
function groupMoveDetails(plan: GroupMovePlan, slots: number, t: TFunction, held = 0): string | undefined {
	const lines = [];
	if (held > 0) lines.push(t("tasks:kanban.groupMove.held", { count: held }));
	if (plan.queued > 0) lines.push(t("tasks:kanban.groupMove.queued", { count: plan.queued, slots }));
	if (plan.skipped > 0) lines.push(t("tasks:kanban.groupMove.skipped", { count: plan.skipped }));
	return lines.length > 0 ? lines.join(" ") : undefined;
}

interface BulkEditsOptions {
	projectId: string | null;
	/** The slots of « En cours » (project setting). */
	maxParallelTasks: number;
	/** Cards a person sent back to the queue: the queue does not start them again at once. */
	heldInQueue: Set<string>;
	/** Starts queued cards while « En cours » has free slots. */
	processQueue: () => Promise<void>;
	selectedTasks: readonly Task[];
	deselectAllTasks: () => void;
	/** The confirmation for a selection that holds work (a plan, a worktree). */
	openDeleteConfirm: () => void;
}

/**
 * What the bulk bar, the selection's right-click menu and Ctrl+Z do: type,
 * priority, move and delete on every selected card, recorded for undo.
 * Design: docs/architecture/kanban-quick-edit.md.
 */
export function useBoardBulkEdits({
	projectId,
	maxParallelTasks,
	heldInQueue,
	processQueue,
	selectedTasks,
	deselectAllTasks,
	openDeleteConfirm,
}: BulkEditsOptions) {
	const { t } = useTranslation(["tasks"]);

	// Undo belongs to the project on screen.
	useEffect(() => {
		useBoardUndoStore.getState().forProject(projectId);
	}, [projectId]);

	const reportFailures = useCallback(
		(failed: number) => {
			if (failed === 0) return;
			toast({
				variant: "destructive",
				title: t("tasks:kanban.bulk.saveFailed", { count: failed }),
			});
		},
		[t],
	);

	const setType = useCallback(
		async (type: CardType) => {
			reportFailures(
				await applyCardChoice(
					selectedTasks,
					cardTypeChoiceMetadata(type),
					t("tasks:kanban.undoLabels.type"),
				),
			);
		},
		[selectedTasks, reportFailures, t],
	);

	const setPriority = useCallback(
		async (priority: TaskPriority) => {
			reportFailures(
				await applyCardChoice(
					selectedTasks,
					{ priority },
					t("tasks:kanban.undoLabels.priority"),
				),
			);
		},
		[selectedTasks, reportFailures, t],
	);

	const deleteSelection = useCallback(() => {
		if (!selectedTasks.every(isLightCard)) {
			openDeleteConfirm();
			return;
		}
		deleteCardsLater(selectedTasks, t);
		deselectAllTasks();
	}, [selectedTasks, openDeleteConfirm, deselectAllTasks, t]);

	// Each card follows the rules of a single drop (lib/group-move.ts): a card
	// already there stays, « En cours » takes what its free slots allow and the
	// rest waits in the queue, held there until the queue has run once.
	const moveSelection = useCallback(
		async (target: TaskStatusColumn) => {
			const running = countRunning(useTaskStore.getState().tasks);
			const plan = planGroupMove(selectedTasks, target, maxParallelTasks - running);
			if (plan.moves.length === 0) {
				toast({ title: t("tasks:kanban.groupMove.nothing"), description: groupMoveDetails(plan, maxParallelTasks, t) });
				return;
			}
			let failed = 0;
			let held = 0;
			const moved = [];
			for (const { task, to } of plan.moves) {
				if (to === "queue" && task.status === "in_progress") heldInQueue.add(task.id);
				const result = await persistTaskStatus(task.id, to);
				if (result.success) moved.push({ id: task.id, from: task.status, to });
				// Held by the pre-analysis: its dialog asks what the card needs.
				else if (result.held) held++;
				else failed++;
			}
			// On top of their new column, in the selection's order.
			const store = useTaskStore.getState();
			for (const m of [...moved].reverse()) store.moveTaskToColumnTop(m.id, m.to, getVisualColumn(m.from));
			if (projectId && moved.length > 0) store.saveTaskOrder(projectId);
			recordMoves(moved, t("tasks:kanban.undoLabels.move", { count: moved.length }));
			if (moved.some((m) => m.from === "in_progress")) await processQueue();
			for (const { task, to } of plan.moves) if (to === "queue") heldInQueue.delete(task.id);
			if (failed > 0) {
				toast({
					title: t("tasks:kanban.bulkMoveError", { failed, total: plan.moves.length }),
					variant: "destructive",
				});
				return;
			}
			toast({
				title: t("tasks:kanban.bulkMoveSuccess", { count: moved.length }),
				description: groupMoveDetails(plan, maxParallelTasks, t, held),
			});
			deselectAllTasks();
		},
		[selectedTasks, deselectAllTasks, projectId, maxParallelTasks, heldInQueue, processQueue, t],
	);

	const undo = useCallback(async () => {
		const result = await undoLast();
		if (!result) {
			toast({ title: t("tasks:kanban.undoNothing") });
		} else if (result.undone) {
			toast({ title: t("tasks:kanban.undone", { label: result.label }) });
		} else {
			toast({
				variant: "destructive",
				title: t("tasks:kanban.undoStale", { label: result.label }),
			});
		}
	}, [t]);

	return useMemo(
		() => ({ setType, setPriority, deleteSelection, moveSelection, undo }),
		[setType, setPriority, deleteSelection, moveSelection, undo],
	);
}
