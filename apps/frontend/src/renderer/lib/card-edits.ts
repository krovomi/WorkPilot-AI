import type { Task, TaskMetadata, TaskStatus } from "../../shared/types";
import { recordUndo } from "../stores/board-undo-store";
import {
	persistTaskStatus,
	persistUpdateTask,
	useTaskStore,
} from "../stores/task-store";

/**
 * A card nothing has worked on yet (Planification or File d'attente, no
 * plan, no worktree, never started): deleting it loses only its text, so it
 * is deleted after a few seconds with an undo instead of a confirmation.
 */
export function isLightCard(task: Task): boolean {
	return (
		(task.status === "backlog" || task.status === "queue") &&
		task.subtasks.length === 0 &&
		task.location !== "worktree" &&
		(task.executionProgress?.phase ?? "idle") === "idle"
	);
}

/** The metadata a quick edit changes: type (kind, category) and priority. */
export type CardChoice = Pick<TaskMetadata, "kind" | "kindSource" | "category" | "priority">;

function currentTask(id: string): Task | undefined {
	return useTaskStore.getState().tasks.find((task) => task.id === id);
}

function holds(metadata: TaskMetadata | undefined, change: CardChoice): boolean {
	return (Object.keys(change) as (keyof CardChoice)[]).every(
		(key) => metadata?.[key] === change[key],
	);
}

function previousOf(metadata: TaskMetadata | undefined, change: CardChoice): CardChoice {
	const previous: Record<string, unknown> = {};
	for (const key of Object.keys(change) as (keyof CardChoice)[]) {
		previous[key] = metadata?.[key];
	}
	return previous as CardChoice;
}

/**
 * Writes one type or priority change on cards that do not have it yet, and
 * records it for Ctrl+Z (undone only on cards that still have it). Resolves
 * the number of cards that could not be saved.
 */
export async function applyCardChoice(
	tasks: readonly Task[],
	change: CardChoice,
	label: string,
): Promise<number> {
	const before = new Map<string, CardChoice>();
	let failed = 0;
	for (const task of tasks) {
		if (holds(task.metadata, change)) continue;
		if (await persistUpdateTask(task.id, { metadata: change })) {
			before.set(task.id, previousOf(task.metadata, change));
		} else {
			failed++;
		}
	}
	if (before.size > 0) {
		recordUndo({
			label,
			undo: async () => {
				let undone = true;
				for (const [id, previous] of before) {
					const task = currentTask(id);
					const restored =
						!!task &&
						holds(task.metadata, change) &&
						(await persistUpdateTask(id, { metadata: previous }));
					undone &&= restored;
				}
				return undone;
			},
		});
	}
	return failed;
}

/** Moves that can be taken back: none of them starts or stops an agent. */
const UNDOABLE_COLUMNS: ReadonlySet<TaskStatus> = new Set(["backlog", "queue"]);

export interface CardMove {
	id: string;
	from: TaskStatus;
	to: TaskStatus;
}

/**
 * Records moves for Ctrl+Z, keeping only those between Planification and
 * File d'attente. A card is moved back only if it is still where it went.
 */
export function recordMoves(moves: readonly CardMove[], label: string): void {
	const undoable = moves.filter(
		(move) =>
			move.from !== move.to &&
			UNDOABLE_COLUMNS.has(move.from) &&
			UNDOABLE_COLUMNS.has(move.to),
	);
	if (undoable.length === 0) return;
	recordUndo({
		label,
		undo: async () => {
			let undone = true;
			for (const move of undoable) {
				const restored =
					currentTask(move.id)?.status === move.to &&
					(await persistTaskStatus(move.id, move.from)).success;
				undone &&= restored;
			}
			return undone;
		},
	});
}

/**
 * Writes a card's new title and records it for Ctrl+Z (undone only while
 * the card still has that title). Resolves false when it was not saved.
 */
export async function renameCard(task: Task, title: string, label: string): Promise<boolean> {
	if (!(await persistUpdateTask(task.id, { title }))) return false;
	recordUndo({
		label,
		undo: async () =>
			currentTask(task.id)?.title === title &&
			(await persistUpdateTask(task.id, { title: task.title })),
	});
	return true;
}
