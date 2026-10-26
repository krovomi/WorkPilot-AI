/**
 * The questions ACP agents are waiting on, by task, for the card.
 *
 * Filled from the main process (which validated each question) and emptied
 * when the build says the question is resolved or its process exits.
 */
import { create } from "zustand";
import type {
	TaskPermissionAnswerResult,
	TaskPermissionRequest,
} from "../../shared/types/task-permission";

interface TaskPermissionState {
	/** taskId → its waiting questions, oldest first. */
	byTask: Record<string, TaskPermissionRequest[]>;
	add: (request: TaskPermissionRequest) => void;
	remove: (taskId: string, requestId: string) => void;
	replaceAll: (requests: TaskPermissionRequest[]) => void;
}

export const useTaskPermissionStore = create<TaskPermissionState>((set) => ({
	byTask: {},
	add: (request) =>
		set((state) => {
			const current = state.byTask[request.taskId] ?? [];
			if (current.some((r) => r.requestId === request.requestId)) return state;
			return { byTask: { ...state.byTask, [request.taskId]: [...current, request] } };
		}),
	remove: (taskId, requestId) =>
		set((state) => {
			const current = state.byTask[taskId];
			if (!current) return state;
			const rest = current.filter((r) => r.requestId !== requestId);
			const byTask = { ...state.byTask };
			if (rest.length) byTask[taskId] = rest;
			else delete byTask[taskId];
			return { byTask };
		}),
	replaceAll: (requests) =>
		set(() => {
			const byTask: Record<string, TaskPermissionRequest[]> = {};
			for (const request of requests) {
				byTask[request.taskId] = [...(byTask[request.taskId] ?? []), request];
			}
			return { byTask };
		}),
}));

/** The oldest question a task is waiting on, matched by task or spec id. */
export function pendingPermission(
	byTask: Record<string, TaskPermissionRequest[]>,
	taskId: string,
	specId?: string,
): TaskPermissionRequest | undefined {
	return byTask[taskId]?.[0] ?? (specId ? byTask[specId]?.[0] : undefined);
}

/** Send the person's choice; the question leaves the card when the build says so. */
export async function answerTaskPermission(
	request: TaskPermissionRequest,
	optionId: string,
): Promise<TaskPermissionAnswerResult> {
	const answer = globalThis.electronAPI?.answerTaskPermission;
	if (!answer) return { ok: false, reason: "process_gone" };
	const result = await answer(request.taskId, request.requestId, optionId);
	if (!result.ok && result.reason !== "invalid_option") {
		// Nobody is waiting for it any more.
		useTaskPermissionStore.getState().remove(request.taskId, request.requestId);
	}
	return result;
}

let teardown: (() => void) | null = null;

/** Registered once by `global-listeners.ts`; idempotent. */
export function setupTaskPermissionListeners(): () => void {
	if (teardown) return teardown;
	const api = globalThis.electronAPI;
	const unsubscribers: Array<() => void> = [];
	const store = useTaskPermissionStore.getState();
	if (typeof api?.onTaskPermissionRequest === "function") {
		unsubscribers.push(api.onTaskPermissionRequest((request) => store.add(request)));
	}
	if (typeof api?.onTaskPermissionCleared === "function") {
		unsubscribers.push(
			api.onTaskPermissionCleared((taskId, requestId) => store.remove(taskId, requestId)),
		);
	}
	if (typeof api?.listTaskPermissions === "function") {
		// A reloaded renderer: the questions already waiting.
		void api
			.listTaskPermissions()
			.then((requests) => store.replaceAll(requests))
			.catch(() => undefined);
	}
	teardown = () => {
		teardown = null;
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
	return teardown;
}
