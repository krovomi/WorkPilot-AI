/**
 * Spec Approval: the plans waiting for a person, read from the task store.
 *
 * A task waits for its plan to be approved when it sits in `human_review`
 * with `reviewReason: "plan_review"`; that is the list. The decision goes
 * through the task's review channel (`submitReview`, then `startTask` on an
 * approval), exactly as the plan approval on the card does, so the build sees
 * it (`review_state.json`). This store only loads the spec files shown next
 * to the decision.
 */

import { create } from "zustand";
import type { Task } from "../../shared/types";

export interface SpecReviewContent {
	spec_id?: string;
	spec_md?: string;
	requirements_json?: string;
	context_json?: string;
	implementation_plan_json?: string;
}

/** Whether a task's plan waits for a person. */
export function isAwaitingPlanApproval(task: Task): boolean {
	return task.status === "human_review" && task.reviewReason === "plan_review";
}

/** The tasks of a project whose plan waits for a person, oldest first. */
export function pendingPlanApprovals(tasks: Task[], projectId: string | undefined): Task[] {
	if (!projectId) return [];
	return tasks
		.filter((task) => task.projectId === projectId && isAwaitingPlanApproval(task))
		.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
}

interface SpecApprovalState {
	content: SpecReviewContent | null;
	contentFor: string | null;
	isLoading: boolean;
	error: string | null;
	loadContent: (projectDir: string, specId: string) => Promise<void>;
	clear: () => void;
	setError: (error: string | null) => void;
}

export const useSpecApprovalStore = create<SpecApprovalState>((set, get) => ({
	content: null,
	contentFor: null,
	isLoading: false,
	error: null,

	loadContent: async (projectDir, specId) => {
		set({ isLoading: true, error: null, content: null, contentFor: specId });
		try {
			const result = (await globalThis.electronAPI.invoke(
				"specApproval:getSpec",
				projectDir,
				specId,
			)) as { success: boolean; data?: SpecReviewContent; error?: string };
			// A slower answer for a spec no longer selected is dropped.
			if (get().contentFor !== specId) return;
			if (result.success) {
				set({ content: result.data ?? null });
			} else {
				set({ error: result.error ?? "Failed to load the specification" });
			}
		} catch (err) {
			if (get().contentFor === specId) set({ error: String(err) });
		} finally {
			if (get().contentFor === specId) set({ isLoading: false });
		}
	},

	clear: () => set({ content: null, contentFor: null, error: null, isLoading: false }),
	setError: (error) => set({ error }),
}));
