import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	type CardType,
	cardTypeChoiceMetadata,
} from "../../shared/constants/card-types";
import type { Task, TaskPriority, TaskStatus } from "../../shared/types";
import { deleteCardsLater } from "../components/kanban/deleteCardsLater";
import { applyCardChoice, isLightCard, recordMoves } from "../lib/card-edits";
import { undoLast, useBoardUndoStore } from "../stores/board-undo-store";
import { persistTaskStatus } from "../stores/task-store";
import { toast } from "./use-toast";

interface BulkEditsOptions {
	projectId: string | null;
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

	const moveSelection = useCallback(
		async (targetStatus: TaskStatus) => {
			let failed = 0;
			const moved = [];
			for (const task of selectedTasks) {
				if ((await persistTaskStatus(task.id, targetStatus)).success) {
					moved.push({ id: task.id, from: task.status, to: targetStatus });
				} else {
					failed++;
				}
			}
			recordMoves(moved, t("tasks:kanban.undoLabels.move", { count: moved.length }));
			if (failed === 0) {
				toast({ title: t("tasks:kanban.bulkMoveSuccess", { count: moved.length }) });
				deselectAllTasks();
			} else {
				toast({
					title: t("tasks:kanban.bulkMoveError", {
						failed,
						total: selectedTasks.length,
					}),
					variant: "destructive",
				});
			}
		},
		[selectedTasks, deselectAllTasks, t],
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
