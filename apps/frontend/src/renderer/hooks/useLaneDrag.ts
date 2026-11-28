/**
 * Drag and drop across the Kanban's lanes (kanban/BoardLanes.tsx), wrapped
 * around the board's own handlers (KanbanBoard `handleDragOver` /
 * `handleDragEnd`), which keep deciding the column move:
 *
 * - a lane's column is a drop target of its own (`laneDropId`); the board's
 *   handlers receive the plain column id, as without lanes;
 * - a card dropped in another lane first gets that lane's field written
 *   (priority, type, sub-project, sprint, `laneMetadata`), the whole selection when
 *   the card is part of one, recorded for Ctrl+Z; a lane whose field the
 *   board does not own refuses the drop;
 * - the pinned « Bloquées » lane flags a card dropped in it (reason dialog)
 *   and lifts the flag of a card dragged out of it.
 *
 * Design: docs/architecture/kanban-swimlanes.md.
 */
import type { DragEndEvent, DragOverEvent } from "@dnd-kit/core";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import type { Task } from "../../shared/types";
import { applyCardChoice } from "../lib/card-edits";
import { FLAGGED_LANE, laneKeyOf, laneMetadata, parseLaneDropId } from "../lib/kanban-lanes";
import { useFlagRequestStore } from "../stores/flag-request-store";
import { useKanbanLanesStore } from "../stores/kanban-lanes-store";
import { useSprintStore } from "../stores/sprint-store";
import { unflagTask } from "../stores/task-flag-actions";
import { useTaskStore } from "../stores/task-store";
import { toast } from "./use-toast";

/** The lane under the dragged card: only that lane's column lights up. */
export const useLaneOverStore = create<{ lane: string | null }>(() => ({ lane: null }));

type DragEvent = DragOverEvent | DragEndEvent;

function taskById(id: string): Task | undefined {
	return useTaskStore.getState().tasks.find((task) => task.id === id);
}

/** The lane a drop target belongs to: a lane's column, or the card under the pointer. */
export function laneOfTarget(overId: string): string | null {
	const target = parseLaneDropId(overId);
	if (target) return target.lane;
	const over = taskById(overId);
	return over ? laneKeyOf(over, useKanbanLanesStore.getState()) : null;
}

/** The event the board's handlers expect: a lane's column becomes the column itself. */
export function withPlainColumn<E extends DragEvent>(event: E): E {
	const target = event.over ? parseLaneDropId(String(event.over.id)) : null;
	if (!target || !event.over) return event;
	return { ...event, over: { ...event.over, id: target.column } };
}

export function useLaneDrag(
	onDragOver: (event: DragOverEvent) => void,
	onDragEnd: (event: DragEndEvent) => Promise<void> | void,
	selection: readonly Task[],
) {
	const { t } = useTranslation(["tasks"]);

	const handleDragOver = useCallback(
		(event: DragOverEvent) => {
			if (useKanbanLanesStore.getState().grouping !== "none") {
				const overId = event.over ? String(event.over.id) : null;
				const lane = overId ? laneOfTarget(overId) : null;
				if (useLaneOverStore.getState().lane !== lane) useLaneOverStore.setState({ lane });
			}
			onDragOver(withPlainColumn(event));
		},
		[onDragOver],
	);

	/** Writes the target lane's field on the moved cards; false when the drop is refused. */
	const moveToLane = useCallback(
		async (cards: readonly Task[], target: string): Promise<boolean> => {
			const { grouping } = useKanbanLanesStore.getState();
			if (target === FLAGGED_LANE) {
				const ids = cards.filter((card) => card.status !== "done").map((card) => card.id);
				if (ids.length > 0) useFlagRequestStore.getState().request(ids);
				return true;
			}
			const flagged = cards.filter((card) => card.metadata?.flagged === true);
			// Out of « Bloquées » into the card's own lane: only the flag goes.
			const ownLane = cards.every((card) => laneKeyOf(card, { grouping, pinFlagged: false }) === target);
			const open = useSprintStore
				.getState()
				.sprints.filter((sprint) => sprint.state !== "closed")
				.map((sprint) => sprint.id);
			const change = ownLane ? null : laneMetadata(grouping, target, open);
			if (!ownLane && !change) {
				toast({ title: t("tasks:kanban.lanes.readOnlyDrop", { grouping: t(`tasks:kanban.lanes.groupings.${grouping}`) }) });
				return false;
			}
			let failed = 0;
			for (const card of flagged) {
				if (!(await unflagTask(card.id)).success) failed++;
			}
			if (change) failed += await applyCardChoice(cards, change, t("tasks:kanban.lanes.undoLabel"));
			if (failed > 0) {
				toast({ variant: "destructive", title: t("tasks:kanban.lanes.saveFailed", { count: failed }) });
			}
			return true;
		},
		[t],
	);

	const handleDragEnd = useCallback(
		async (event: DragEndEvent) => {
			useLaneOverStore.setState({ lane: null });
			const lanes = useKanbanLanesStore.getState();
			const activeId = String(event.active.id);
			const task = taskById(activeId);
			if (lanes.grouping === "none" || !event.over || !task) return onDragEnd(withPlainColumn(event));
			const target = laneOfTarget(String(event.over.id));
			if (target !== null && target !== laneKeyOf(task, lanes)) {
				const inSelection = selection.length > 1 && selection.some((card) => card.id === task.id);
				const cards = (inSelection ? selection : [task]).filter((card) => laneKeyOf(card, lanes) !== target);
				// A refused drop ends like a cancelled one: the board clears its drag state.
				if (!(await moveToLane(cards, target))) return onDragEnd({ ...event, over: null });
			}
			return onDragEnd(withPlainColumn(event));
		},
		[onDragEnd, moveToLane, selection],
	);

	return { onDragOver: handleDragOver, onDragEnd: handleDragEnd };
}
