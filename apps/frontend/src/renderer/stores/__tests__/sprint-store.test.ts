/**
 * @vitest-environment jsdom
 */
/**
 * The sprint store: a start records what the sprint holds, a close counts
 * what was done and moves the unfinished cards on before the report is
 * written, a deletion sends the cards back to the backlog first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../__tests__/helpers/renderer-api";
import type { Sprint, Task } from "../../../shared/types";
import { sprintReport, useSprintStore } from "../sprint-store";
import { useTaskStore } from "../task-store";

const A = "sp-0000000a";
const B = "sp-0000000b";

function card(id: string, status: Task["status"], sprintId?: string, score?: number): Task {
	return {
		id,
		specId: id,
		projectId: "p1",
		title: id,
		description: "",
		status,
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		metadata: { sprintId, smartEstimate: score ? { complexityScore: score } : undefined },
	} as Task;
}

const sprints: Sprint[] = [
	{ id: A, name: "A", state: "active", createdAt: "t" },
	{ id: B, name: "B", state: "planned", createdAt: "t" },
];

let api: RendererApi;
const answer = vi.fn(async (..._args: unknown[]) => ({ success: true, data: sprints }));

function install(fail: ReadonlySet<string> = new Set()) {
	api = installRendererApi({
		listSprints: answer,
		startSprint: answer,
		completeSprint: answer,
		deleteSprint: answer,
		saveSprint: answer,
		updateTask: vi.fn(async (id: string, updates: { metadata?: object }) => {
			if (fail.has(id)) return { success: false, error: "locked" };
			const task = useTaskStore.getState().tasks.find((t) => t.id === id);
			return { success: true, data: { ...task, metadata: { ...task?.metadata, ...updates.metadata } } };
		}),
	});
}

beforeEach(async () => {
	answer.mockClear();
	install();
	useTaskStore.setState({
		tasks: [card("done", "done", A, 5), card("open", "in_progress", A, 3), card("other", "backlog", B)],
	});
	useSprintStore.setState({ projectId: null, sprints: [] });
	await useSprintStore.getState().load("p1");
});

afterEach(() => api.restore());

const sprintOf = (id: string) => useTaskStore.getState().tasks.find((t) => t.id === id)?.metadata?.sprintId;

describe("sprint store", () => {
	it("loads the project's sprints", () => {
		expect(answer).toHaveBeenCalledWith("p1");
		expect(useSprintStore.getState().sprints).toEqual(sprints);
	});

	it("starts a sprint with what it holds", async () => {
		expect(await useSprintStore.getState().start(B)).toEqual({ ok: true });
		expect(answer).toHaveBeenLastCalledWith("p1", B, { cards: 1, points: 0 });
	});

	it("moves the unfinished cards on, then records the report", async () => {
		expect(sprintReport(useTaskStore.getState().tasks, A, B)).toEqual({
			done: 1,
			donePoints: 5,
			carried: 1,
			carriedPoints: 3,
			carriedTo: B,
		});
		expect(await useSprintStore.getState().complete(A, B)).toEqual({ ok: true });
		expect(sprintOf("open")).toBe(B);
		expect(sprintOf("done")).toBe(A);
		expect(answer).toHaveBeenLastCalledWith("p1", A, expect.objectContaining({ carried: 1, carriedTo: B }));
	});

	it("does not close the sprint when a card could not move", async () => {
		api.restore();
		install(new Set(["open"]));
		answer.mockClear();
		expect(await useSprintStore.getState().complete(A, null)).toEqual({ ok: false, error: "cards_not_moved", failedCards: 1 });
		expect(answer).not.toHaveBeenCalled();
	});

	it("sends a deleted sprint's cards back to the backlog first", async () => {
		expect(await useSprintStore.getState().remove(B)).toEqual({ ok: true });
		expect(sprintOf("other")).toBeUndefined();
		expect(answer).toHaveBeenLastCalledWith("p1", B);
	});

	it("reports a refusal from the main process", async () => {
		answer.mockResolvedValueOnce({ success: false, error: "another_active" } as never);
		expect(await useSprintStore.getState().start(B)).toEqual({ ok: false, error: "another_active" });
	});

	it("answers without a project, without the bridge, or when the bridge throws", async () => {
		useSprintStore.setState({ projectId: null });
		expect(await useSprintStore.getState().save({ name: "S" })).toEqual({ ok: false, error: "no_project" });
		useSprintStore.setState({ projectId: "p1" });
		api.restore();
		const before = globalThis.electronAPI;
		(globalThis as { electronAPI?: unknown }).electronAPI = {};
		expect(await useSprintStore.getState().save({ name: "S" })).toEqual({ ok: false, error: "unavailable" });
		(globalThis as { electronAPI?: unknown }).electronAPI = before;
		const failing = vi.fn(async (): Promise<unknown> => {
			throw new Error("gone");
		});
		api = installRendererApi({ saveSprint: failing, listSprints: failing });
		expect(await useSprintStore.getState().save({ name: "S" })).toEqual({ ok: false, error: "gone" });
		failing.mockRejectedValueOnce("odd");
		expect(await useSprintStore.getState().save({ name: "S" })).toEqual({ ok: false, error: "unknown" });
		failing.mockResolvedValueOnce({ success: false });
		expect(await useSprintStore.getState().save({ name: "S" })).toEqual({ ok: false, error: "unknown" });
		// An unreadable list keeps the board going.
		await useSprintStore.getState().load("p1");
		expect(useSprintStore.getState().loading).toBe(false);
	});

	it("keeps an answer for the project it was asked for", async () => {
		let finish: (value: unknown) => void = () => undefined;
		api.restore();
		api = installRendererApi({
			listSprints: vi.fn(async () => ({ success: true, data: [] })),
			saveSprint: vi.fn(() => new Promise((resolve) => (finish = resolve))),
		});
		const pending = useSprintStore.getState().save({ name: "S" });
		await useSprintStore.getState().load("p2");
		finish({ success: true, data: sprints });
		expect(await pending).toEqual({ ok: true });
		expect(useSprintStore.getState().sprints).toEqual([]);
	});

	it("keeps a deleted sprint when one of its cards could not go back to the backlog", async () => {
		api.restore();
		install(new Set(["other"]));
		answer.mockClear();
		expect(await useSprintStore.getState().remove(B)).toEqual({ ok: false, error: "cards_not_moved", failedCards: 1 });
		expect(answer).not.toHaveBeenCalled();
	});

	it("leaves a newer project's state alone when an older read ends", async () => {
		let finish: (value: unknown) => void = () => undefined;
		api.restore();
		api = installRendererApi({
			listSprints: vi
				.fn()
				.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
				.mockResolvedValue({ success: true, data: [] }),
		});
		const older = useSprintStore.getState().load("p3");
		await useSprintStore.getState().load("p4");
		finish({ success: true, data: sprints });
		await older;
		expect(useSprintStore.getState()).toMatchObject({ projectId: "p4", sprints: [], loading: false });
	});
});
