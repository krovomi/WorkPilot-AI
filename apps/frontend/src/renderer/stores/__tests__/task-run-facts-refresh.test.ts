/**
 * A card finished while the app is open shows its bilan: after a status
 * change, the card's history and run facts are read again from main, and
 * nothing else of the card is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStatus } from "../../../shared/types";
import {
	FIRST_REFRESH_MS,
	refreshRunFacts,
	SECOND_REFRESH_MS,
	setupTaskRunFactsListeners,
} from "../task-run-facts-refresh";
import { useTaskStore } from "../task-store";

const PROJECT = "p1";

function task(id: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
	return {
		id,
		specId: id,
		projectId: PROJECT,
		title: id,
		description: "",
		status,
		subtasks: [],
		logs: [],
		...extra,
	} as unknown as Task;
}

const HISTORY = [
	{ from: null, to: "backlog", at: "2026-11-28T17:00:00.000Z", actor: "user" },
	{ from: "backlog", to: "in_progress", at: "2026-11-28T17:01:00.000Z", actor: "user" },
	{ from: "in_progress", to: "human_review", reason: "completed", at: "2026-11-28T17:21:00.000Z", actor: "agent" },
] as Task["statusHistory"];

const FACTS: Task["runFacts"] = {
	createdBy: { kind: "person", name: "Leub" },
	startedBy: { kind: "person", name: "Leub" },
	usage: {
		inputTokens: 1200,
		outputTokens: 300,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.42,
		sessions: 3,
		estimatedSessions: 0,
		models: ["claude-opus-5-5"],
	},
};

let getTasks: ReturnType<typeof vi.fn>;
let teardown: (() => void) | null = null;

const card = (id: string) => useTaskStore.getState().tasks.find((t) => t.id === id);

beforeEach(() => {
	getTasks = vi.fn();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { getTasks };
});

afterEach(() => {
	teardown?.();
	teardown = null;
	vi.useRealTimers();
	useTaskStore.setState({ tasks: [] });
	delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("refreshRunFacts", () => {
	it("copies the history and the run facts read again onto the card, nothing else", async () => {
		useTaskStore.setState({
			tasks: [task("001-a", "human_review", { reviewReason: "completed", logs: ["live log"] })],
		});
		getTasks.mockResolvedValue({
			success: true,
			data: [task("001-a", "in_progress", { statusHistory: HISTORY, runFacts: FACTS })],
		});

		await expect(refreshRunFacts(PROJECT)).resolves.toBe(1);

		expect(getTasks).toHaveBeenCalledWith(PROJECT);
		const updated = card("001-a");
		expect(updated?.statusHistory).toEqual(HISTORY);
		expect(updated?.runFacts).toEqual(FACTS);
		// The live state the events made stays: the disk may be a step behind.
		expect(updated?.status).toBe("human_review");
		expect(updated?.reviewReason).toBe("completed");
		expect(updated?.logs).toEqual(["live log"]);
	});

	it("leaves a card alone when nothing changed, and other projects' cards", async () => {
		const same = task("001-a", "done", { statusHistory: HISTORY, runFacts: FACTS });
		const other = { ...task("002-b", "done"), projectId: "p2" };
		useTaskStore.setState({ tasks: [same, other] });
		getTasks.mockResolvedValue({
			success: true,
			data: [
				task("001-a", "done", { statusHistory: HISTORY, runFacts: FACTS }),
				task("002-b", "done", { runFacts: FACTS }),
			],
		});

		await expect(refreshRunFacts(PROJECT)).resolves.toBe(0);
		expect(card("001-a")).toBe(same);
		expect(card("002-b")?.runFacts).toBeUndefined();
	});

	it("changes nothing when main cannot answer", async () => {
		useTaskStore.setState({ tasks: [task("001-a", "done")] });
		getTasks.mockResolvedValueOnce({ success: false, error: "no project" });
		await expect(refreshRunFacts(PROJECT)).resolves.toBe(0);
		getTasks.mockRejectedValueOnce(new Error("gone"));
		await expect(refreshRunFacts(PROJECT)).resolves.toBe(0);
		expect(card("001-a")?.runFacts).toBeUndefined();
	});
});

describe("setupTaskRunFactsListeners", () => {
	it("reads the bilan again after a card's status changes, twice, debounced", async () => {
		vi.useFakeTimers();
		useTaskStore.setState({ tasks: [task("001-a", "in_progress"), task("002-b", "backlog")] });
		getTasks.mockResolvedValue({
			success: true,
			data: [task("001-a", "human_review", { statusHistory: HISTORY, runFacts: FACTS })],
		});
		teardown = setupTaskRunFactsListeners();
		expect(setupTaskRunFactsListeners()).toBe(teardown);

		useTaskStore.getState().updateTaskStatus("001-a", "ai_review");
		await vi.advanceTimersByTimeAsync(500);
		useTaskStore.getState().updateTaskStatus("001-a", "human_review", "completed");
		await vi.advanceTimersByTimeAsync(FIRST_REFRESH_MS - 1);
		expect(getTasks).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(getTasks).toHaveBeenCalledTimes(1);
		expect(card("001-a")?.runFacts).toEqual(FACTS);
		expect(card("001-a")?.statusHistory).toEqual(HISTORY);

		await vi.advanceTimersByTimeAsync(SECOND_REFRESH_MS - FIRST_REFRESH_MS);
		expect(getTasks).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(SECOND_REFRESH_MS * 2);
		expect(getTasks).toHaveBeenCalledTimes(2);
	});

	it("stops reading once torn down", async () => {
		vi.useFakeTimers();
		useTaskStore.setState({ tasks: [task("001-a", "in_progress")] });
		getTasks.mockResolvedValue({ success: true, data: [] });
		teardown = setupTaskRunFactsListeners();
		useTaskStore.getState().updateTaskStatus("001-a", "done");
		teardown();
		teardown = null;
		await vi.advanceTimersByTimeAsync(SECOND_REFRESH_MS * 2);
		expect(getTasks).not.toHaveBeenCalled();
	});
});
