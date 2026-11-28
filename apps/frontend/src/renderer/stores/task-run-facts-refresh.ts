/**
 * Keeps the « Bilan » of a card in step with the disk while the app is open.
 *
 * A card's status history and run facts (who created and launched it, what
 * its agents spent: `main/task-run-facts.ts`) are read by main when the board
 * loads. A status change only patches the card's status in the store
 * (`updateTaskStatus`), so a card created and finished in the same session
 * kept the facts of its first load, if any: every line of its bilan read
 * « unknown » until the app was restarted.
 *
 * Here, every status change of a card asks main for the board again (the same
 * `TASK_LIST` call the board makes, local or server project, never the forced
 * refresh), shortly after the change and once more a little later, when the
 * last session's spend has reached its ledger. Only `statusHistory` and
 * `runFacts` are taken from the answer: the live status, progress and logs
 * stay what the events made them.
 */
import type { Task } from "../../shared/types";
import { debugWarn } from "../../shared/utils/debug-logger";
import { useTaskStore } from "./task-store";

/** After the change: main has written the history by then. */
export const FIRST_REFRESH_MS = 1_500;
/** Once more: past main's 3 s task cache and the last ledger write. */
export const SECOND_REFRESH_MS = 6_000;

type Fresh = Pick<Task, "statusHistory" | "runFacts">;

function sameFacts(task: Task, fresh: Fresh): boolean {
	return (
		JSON.stringify(task.statusHistory ?? null) ===
			JSON.stringify(fresh.statusHistory ?? null) &&
		JSON.stringify(task.runFacts ?? null) ===
			JSON.stringify(fresh.runFacts ?? null)
	);
}

/**
 * Read the project's tasks again and copy each card's history and run facts
 * onto the card the store holds. Returns how many cards changed.
 */
export async function refreshRunFacts(projectId: string): Promise<number> {
	const api = globalThis.electronAPI;
	if (typeof api?.getTasks !== "function") return 0;
	let fresh: Task[];
	try {
		const result = await api.getTasks(projectId);
		if (!result.success || !result.data) return 0;
		fresh = result.data;
	} catch (error) {
		debugWarn("[taskRunFacts] tasks not read again:", error);
		return 0;
	}
	const byId = new Map(fresh.map((task) => [task.id, task]));
	const store = useTaskStore.getState();
	let changed = 0;
	for (const task of store.tasks) {
		if (task.projectId !== projectId) continue;
		const next = byId.get(task.id);
		if (!next) continue;
		const facts: Fresh = {
			statusHistory: next.statusHistory,
			runFacts: next.runFacts,
		};
		if (sameFacts(task, facts)) continue;
		store.updateTask(task.id, facts);
		changed += 1;
	}
	return changed;
}

const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

/** Refresh a project's run facts soon, and again a little later; debounced. */
export function scheduleRunFactsRefresh(projectId: string): void {
	for (const timer of timers.get(projectId) ?? []) clearTimeout(timer);
	const run = () => void refreshRunFacts(projectId);
	const first = setTimeout(run, FIRST_REFRESH_MS);
	const second = setTimeout(() => {
		timers.delete(projectId);
		run();
	}, SECOND_REFRESH_MS);
	timers.set(projectId, [first, second]);
}

let teardown: (() => void) | null = null;

/** Registered once by `global-listeners.ts`; idempotent. */
export function setupTaskRunFactsListeners(): () => void {
	if (teardown) return teardown;
	const unregister = useTaskStore
		.getState()
		.registerTaskStatusChangeListener((taskId) => {
			// A reason alone can change too (a review that becomes completed):
			// any change is worth a read, the timers merge them.
			const task = useTaskStore
				.getState()
				.tasks.find((t) => t.id === taskId || t.specId === taskId);
			if (task?.projectId) scheduleRunFactsRefresh(task.projectId);
		});
	teardown = () => {
		teardown = null;
		unregister();
		for (const list of timers.values()) {
			for (const timer of list) clearTimeout(timer);
		}
		timers.clear();
	};
	return teardown;
}
