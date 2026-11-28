/**
 * Cards the pre-analysis held back before « En cours »
 * (docs/architecture/task-readiness.md), and the ones a person chose to start
 * as they are. `components/task-readiness/ReadinessDialog.tsx` shows the first.
 */
import { create } from "zustand";
import type { TaskReadiness } from "../../shared/types";

export interface HeldCard {
	readonly taskId: string;
	readonly readiness: TaskReadiness;
}

interface TaskReadinessState {
	held: HeldCard[];
	/** Started as they are: the pre-analysis does not stop them again. */
	accepted: ReadonlySet<string>;
	hold: (taskId: string, readiness: TaskReadiness) => void;
	release: (taskId: string) => void;
	accept: (taskId: string) => void;
}

export const useTaskReadinessStore = create<TaskReadinessState>((set) => ({
	held: [],
	accepted: new Set(),
	// A card held twice (the queue retrying it) is shown once, with the latest verdict.
	hold: (taskId, readiness) =>
		set((s) => ({ held: [...s.held.filter((h) => h.taskId !== taskId), { taskId, readiness }] })),
	release: (taskId) => set((s) => ({ held: s.held.filter((h) => h.taskId !== taskId) })),
	accept: (taskId) =>
		set((s) => ({
			accepted: new Set([...s.accepted, taskId]),
			held: s.held.filter((h) => h.taskId !== taskId),
		})),
}));
