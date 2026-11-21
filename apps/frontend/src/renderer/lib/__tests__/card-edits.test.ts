import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import type { Task } from "../../../shared/types";
import { undoLast, useBoardUndoStore } from "../../stores/board-undo-store";
import { useTaskStore } from "../../stores/task-store";
import { applyCardChoice, isLightCard, recordMoves, renameCard } from "../card-edits";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "001",
		projectId: "p1",
		title: "Card",
		description: "",
		status: "backlog",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Task;
}

let api: RendererApi;

/** The main process merges metadata like TASK_UPDATE does. */
function installUpdates(fail: ReadonlySet<string> = new Set()) {
	api = installRendererApi({
		updateTask: vi.fn(async (id: string, updates: { metadata?: object }) => {
			if (fail.has(id)) return { success: false, error: "locked" };
			const task = useTaskStore.getState().tasks.find((t) => t.id === id);
			return {
				success: true,
				data: { ...task, metadata: { ...task?.metadata, ...updates.metadata } },
			};
		}),
		updateTaskStatus: vi.fn(async () => ({ success: true })),
	});
}

beforeEach(() => {
	useBoardUndoStore.getState().clear();
	installUpdates();
});

afterEach(() => api.restore());

const metadataOf = (id: string) =>
	useTaskStore.getState().tasks.find((t) => t.id === id)?.metadata;

describe("isLightCard", () => {
	it("is a planned or queued card nothing worked on", () => {
		expect(isLightCard(makeTask())).toBe(true);
		expect(isLightCard(makeTask({ status: "queue" }))).toBe(true);
		expect(
			isLightCard(makeTask({ executionProgress: { phase: "idle" } as never })),
		).toBe(true);
	});

	it("is not a card with a plan, a worktree, a run or past the queue", () => {
		expect(isLightCard(makeTask({ status: "in_progress" }))).toBe(false);
		expect(isLightCard(makeTask({ subtasks: [{ id: "s" }] as never }))).toBe(false);
		expect(isLightCard(makeTask({ location: "worktree" }))).toBe(false);
		expect(
			isLightCard(makeTask({ executionProgress: { phase: "planning" } as never })),
		).toBe(false);
	});
});

describe("applyCardChoice", () => {
	it("writes the change, skips cards that have it, and undoes it", async () => {
		useTaskStore.setState({
			tasks: [
				makeTask({ id: "a", metadata: { priority: "low" } as never }),
				makeTask({ id: "b", metadata: { priority: "high" } as never }),
			],
		});
		const tasks = useTaskStore.getState().tasks;
		expect(await applyCardChoice(tasks, { priority: "high" }, "priority")).toBe(0);
		expect(api.fn("updateTask")).toHaveBeenCalledTimes(1);
		expect(metadataOf("a")?.priority).toBe("high");

		expect(await undoLast()).toEqual({ label: "priority", undone: true });
		expect(metadataOf("a")?.priority).toBe("low");
		expect(metadataOf("b")?.priority).toBe("high");
	});

	it("counts the cards it could not save, and records nothing for none", async () => {
		installUpdates(new Set(["a"]));
		useTaskStore.setState({ tasks: [makeTask({ id: "a" })] });
		expect(
			await applyCardChoice(useTaskStore.getState().tasks, { priority: "urgent" }, "p"),
		).toBe(1);
		expect(useBoardUndoStore.getState().entries).toHaveLength(0);
	});

	it("leaves a card changed since alone on undo", async () => {
		useTaskStore.setState({ tasks: [makeTask({ id: "a" }), makeTask({ id: "b" })] });
		await applyCardChoice(useTaskStore.getState().tasks, { priority: "high" }, "p");
		useTaskStore.getState().updateTask("a", {
			metadata: { priority: "urgent" } as never,
		});
		useTaskStore.setState({
			tasks: useTaskStore.getState().tasks.filter((t) => t.id !== "b"),
		});
		expect(await undoLast()).toEqual({ label: "p", undone: false });
		expect(metadataOf("a")?.priority).toBe("urgent");
	});
});

describe("recordMoves", () => {
	it("keeps only moves between Planification and File d'attente", () => {
		recordMoves(
			[
				{ id: "a", from: "backlog", to: "in_progress" },
				{ id: "b", from: "queue", to: "queue" },
				{ id: "c", from: "done", to: "backlog" },
			],
			"move",
		);
		expect(useBoardUndoStore.getState().entries).toHaveLength(0);
	});

	it("moves a card back only while it is still where it went", async () => {
		useTaskStore.setState({
			tasks: [makeTask({ id: "a", status: "queue" }), makeTask({ id: "b", status: "in_progress" })],
		});
		recordMoves(
			[
				{ id: "a", from: "backlog", to: "queue" },
				{ id: "b", from: "backlog", to: "queue" },
			],
			"move",
		);
		expect(await undoLast()).toEqual({ label: "move", undone: false });
		expect(api.fn("updateTaskStatus")).toHaveBeenCalledTimes(1);
		expect(api.fn("updateTaskStatus").mock.calls[0].slice(0, 2)).toEqual(["a", "backlog"]);
	});
});

describe("renameCard", () => {
	beforeEach(() => {
		api.restore();
		api = installRendererApi({
			updateTask: vi.fn(async (id: string, updates: { title?: string }) => {
				if (updates.title === "refused") return { success: false, error: "locked" };
				const task = useTaskStore.getState().tasks.find((t) => t.id === id);
				return { success: true, data: { ...task, ...updates } };
			}),
		});
	});
	const titleOf = (id: string) => useTaskStore.getState().tasks.find((t) => t.id === id)?.title;

	it("saves the title and undoes it while the card keeps it", async () => {
		const task = makeTask({ title: "Old" });
		useTaskStore.setState({ tasks: [task] });
		expect(await renameCard(task, "New", "rename")).toBe(true);
		expect(titleOf("t1")).toBe("New");
		expect(await undoLast()).toEqual({ label: "rename", undone: true });
		expect(titleOf("t1")).toBe("Old");
	});

	it("does not undo a title changed since, nor a deleted card", async () => {
		const task = makeTask({ title: "Old" });
		useTaskStore.setState({ tasks: [task] });
		await renameCard(task, "New", "rename");
		await renameCard({ ...task, title: "New" }, "Newer", "rename");
		useBoardUndoStore.setState((s) => ({ entries: s.entries.slice(0, 1) }));
		expect((await undoLast())?.undone).toBe(false);
		await renameCard(task, "Again", "rename");
		useTaskStore.setState({ tasks: [] });
		expect((await undoLast())?.undone).toBe(false);
	});

	it("records nothing when the title is not saved", async () => {
		const task = makeTask();
		useTaskStore.setState({ tasks: [task] });
		expect(await renameCard(task, "refused", "rename")).toBe(false);
		expect(useBoardUndoStore.getState().entries).toHaveLength(0);
	});
});
