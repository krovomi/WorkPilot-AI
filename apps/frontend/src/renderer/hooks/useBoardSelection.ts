import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../../shared/types";

/** How a click with a modifier changes the selection. */
export type SelectGesture = "toggle" | "range";

/**
 * The board's card selection (bulk bar, bulk drag, right-click on a
 * selection). Ctrl/Cmd+click toggles a card, Shift+click selects from the
 * last card clicked to this one in the same column. Ids of cards that left
 * the board are dropped. Design: docs/architecture/kanban-quick-edit.md.
 */
export function useBoardSelection(boardTasks: readonly Task[]) {
	const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
		() => new Set(),
	);
	const anchorRef = useRef<string | null>(null);

	useEffect(() => {
		const onBoard = new Set(boardTasks.map((task) => task.id));
		setSelectedTaskIds((prev) => {
			const kept = new Set([...prev].filter((id) => onBoard.has(id)));
			return kept.size === prev.size ? prev : kept;
		});
	}, [boardTasks]);

	const toggleTaskSelection = useCallback((taskId: string) => {
		anchorRef.current = taskId;
		setSelectedTaskIds((prev) => {
			const next = new Set(prev);
			if (!next.delete(taskId)) next.add(taskId);
			return next;
		});
	}, []);

	const selectGesture = useCallback(
		(taskId: string, gesture: SelectGesture, columnTaskIds: readonly string[]) => {
			const anchor = anchorRef.current;
			const from = anchor ? columnTaskIds.indexOf(anchor) : -1;
			const to = columnTaskIds.indexOf(taskId);
			if (gesture === "toggle" || from < 0 || to < 0) {
				toggleTaskSelection(taskId);
				return;
			}
			const range = columnTaskIds.slice(Math.min(from, to), Math.max(from, to) + 1);
			setSelectedTaskIds((prev) => new Set([...prev, ...range]));
		},
		[toggleTaskSelection],
	);

	const selectTasks = useCallback((taskIds: readonly string[]) => {
		setSelectedTaskIds((prev) => new Set([...prev, ...taskIds]));
	}, []);

	const deselectAllTasks = useCallback(() => {
		anchorRef.current = null;
		setSelectedTaskIds(new Set());
	}, []);

	return {
		selectedTaskIds,
		setSelectedTaskIds,
		toggleTaskSelection,
		selectGesture,
		selectTasks,
		deselectAllTasks,
	};
}
