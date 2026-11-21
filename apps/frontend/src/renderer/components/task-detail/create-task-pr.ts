/**
 * The review's "Create Pull Request": opens the task's pull request and
 * records it on the card.
 *
 * The metadata kept is the one in the store when the answer comes, not the
 * copy the review was opened with. While the PR is being created the main
 * process adds to it (`metadata.cicdRun` when CI/CD Triggers starts a
 * pipeline, `metadata.visualProof`) through `TASK_UPDATED_EVENT`; spreading
 * the older copy erased those from the card until the board was reloaded.
 * Found by the cross-feature journey (`e2e/journeys/`).
 */
import type {
	Task,
	WorktreeCreatePROptions,
	WorktreeCreatePRResult,
} from "../../../shared/types";
import { useTaskStore } from "../../stores/task-store";

export async function createTaskPR(
	task: Task,
	options: WorktreeCreatePROptions,
	setIsCreatingPR: (creating: boolean) => void,
): Promise<WorktreeCreatePRResult> {
	setIsCreatingPR(true);
	try {
		const result = await globalThis.electronAPI.createWorktreePR(task.id, options);
		if (result.success && result.data) {
			const { prUrl } = result.data;
			if (result.data.success && prUrl && !result.data.alreadyExists) {
				const store = useTaskStore.getState();
				const current = store.tasks.find((t) => t.id === task.id) ?? task;
				store.updateTask(task.id, {
					status: "done",
					metadata: { ...current.metadata, prUrl },
				});
			}
			return result.data;
		}
		// Propagate the IPC error; CreatePRDialog falls back to its own text.
		return {
			success: false,
			error: result.error,
			prUrl: undefined,
			alreadyExists: false,
			crossReviewBlocked: result.data?.crossReviewBlocked === true,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : undefined,
			prUrl: undefined,
			alreadyExists: false,
		};
	} finally {
		setIsCreatingPR(false);
	}
}
