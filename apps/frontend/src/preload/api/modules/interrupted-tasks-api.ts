/**
 * The launch dialog of the Kanban builds the last exit interrupted
 * (main/ipc-handlers/task/interrupted-prompt.ts).
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	InterruptedResumeResult,
	InterruptedTask,
	InterruptedTasksOffer,
} from "../../../shared/types/interrupted-tasks";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface InterruptedTasksAPI {
	/** The offer still unanswered this launch, or null. */
	getInterruptedTasks: () => Promise<InterruptedTasksOffer | null>;
	/** One project's interrupted builds, put off ones included: offered again. */
	listInterruptedTasks: (projectId: string) => Promise<InterruptedTask[]>;
	/** Resume these ids (only ids the offer named count); the others are put off. */
	resolveInterruptedTasks: (resumeIds: string[]) => Promise<InterruptedResumeResult>;
	onInterruptedTasksOffer: (callback: (offer: InterruptedTasksOffer) => void) => () => void;
}

export const createInterruptedTasksAPI = (): InterruptedTasksAPI => ({
	getInterruptedTasks: () =>
		invokeIpc<InterruptedTasksOffer | null>(IPC_CHANNELS.TASK_INTERRUPTED_GET),
	listInterruptedTasks: (projectId) =>
		invokeIpc<InterruptedTask[]>(IPC_CHANNELS.TASK_INTERRUPTED_LIST, projectId),
	resolveInterruptedTasks: (resumeIds) =>
		invokeIpc<InterruptedResumeResult>(IPC_CHANNELS.TASK_INTERRUPTED_RESOLVE, resumeIds),
	onInterruptedTasksOffer: (callback) =>
		createIpcListener(IPC_CHANNELS.TASK_INTERRUPTED_OFFER, callback),
});
