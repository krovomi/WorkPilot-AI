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
});
