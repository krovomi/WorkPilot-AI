/**
 * Whether each task's commands run in the OS sandbox, by task and provider,
 * as main received it from the build.
 */
import { create } from "zustand";
import type { TaskSandboxStatus } from "../../shared/types/task-sandbox";

interface TaskSandboxState {
	/** taskId → provider → its latest status. */
	byTask: Record<string, Record<string, TaskSandboxStatus>>;
	set: (status: TaskSandboxStatus) => void;
	replaceAll: (statuses: TaskSandboxStatus[]) => void;
}

export const useTaskSandboxStore = create<TaskSandboxState>((set) => ({
	byTask: {},
	set: (status) =>
		set((state) => ({
			byTask: {
				...state.byTask,
				[status.taskId]: { ...state.byTask[status.taskId], [status.provider]: status },
			},
		})),
	replaceAll: (statuses) =>
		set(() => {
			const byTask: Record<string, Record<string, TaskSandboxStatus>> = {};
			for (const status of statuses) {
				byTask[status.taskId] = { ...byTask[status.taskId], [status.provider]: status };
			}
			return { byTask };
		}),
}));

const NOT_ISOLATED = new Set(["unavailable", "off"]);

/** The statuses of a task whose commands are not isolated, by task or spec id. */
export function unisolatedStatuses(
	byTask: Record<string, Record<string, TaskSandboxStatus>>,
	taskId: string,
	specId?: string,
): TaskSandboxStatus[] {
	const statuses = byTask[taskId] ?? (specId ? byTask[specId] : undefined) ?? {};
	return Object.values(statuses).filter((status) => NOT_ISOLATED.has(status.state));
}

let teardown: (() => void) | null = null;

/** Registered once by `global-listeners.ts`; idempotent. */
export function setupTaskSandboxListeners(): () => void {
	if (teardown) return teardown;
	const api = globalThis.electronAPI;
	const unsubscribers: Array<() => void> = [];
	const store = useTaskSandboxStore.getState();
	if (typeof api?.onTaskSandboxStatus === "function") {
		unsubscribers.push(api.onTaskSandboxStatus((status) => store.set(status)));
	}
	if (typeof api?.listTaskSandboxes === "function") {
		void api
			.listTaskSandboxes()
			.then((statuses) => store.replaceAll(statuses))
			.catch(() => undefined);
	}
	teardown = () => {
		teardown = null;
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
	return teardown;
}
