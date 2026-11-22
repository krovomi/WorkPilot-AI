import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../__tests__/helpers/renderer-api";
import type { Task } from "../../../shared/types";
import { useTaskReadinessStore } from "../../stores/task-readiness-store";
import { persistTaskStatus, useTaskStore } from "../../stores/task-store";
import { readyToStart } from "../start-readiness";

const toastMock = vi.hoisted(() => ({ dismiss: vi.fn(), toast: vi.fn() }));
vi.mock("../../hooks/use-toast", () => ({
	toast: (...args: unknown[]) => {
		toastMock.toast(...args);
		return { dismiss: toastMock.dismiss };
	},
}));

const card = (overrides: Partial<Task> = {}) =>
	({ id: "t1", title: "Fix login", description: "", status: "backlog", subtasks: [], ...overrides }) as Task;

let api: RendererApi;
const notReady = { ready: false, questions: [{ id: "q1", question: "Which page?" }] };

beforeEach(() => {
	toastMock.toast.mockReset();
	toastMock.dismiss.mockReset();
	useTaskReadinessStore.setState({ held: [], accepted: new Set() });
});
afterEach(() => api?.restore());

describe("readyToStart", () => {
	it("lets a resumed or an accepted card start without asking", async () => {
		api = installRendererApi();
		expect(await readyToStart(card({ status: "human_review" }))).toBe(true);
		useTaskReadinessStore.getState().accept("t1");
		expect(await readyToStart(card())).toBe(true);
		expect(api.fn("checkTaskReadiness")).not.toHaveBeenCalled();
	});

	it("says it reads a short card, then holds it when it is not ready", async () => {
		api = installRendererApi({ checkTaskReadiness: vi.fn(async () => ({ success: true, data: notReady })) });
		expect(await readyToStart(card())).toBe(false);
		expect(toastMock.toast).toHaveBeenCalledTimes(1);
		expect(toastMock.dismiss).toHaveBeenCalled();
		expect(useTaskReadinessStore.getState().held).toEqual([{ taskId: "t1", readiness: notReady }]);
		// Held again (the queue retrying it): shown once.
		await readyToStart(card());
		expect(useTaskReadinessStore.getState().held).toHaveLength(1);
	});

	it("lets the card start when the check says ready, fails or throws", async () => {
		api = installRendererApi({
			checkTaskReadiness: vi
				.fn()
				.mockResolvedValueOnce({ success: true, data: { ready: true } })
				.mockResolvedValueOnce({ success: false, error: "x" })
				.mockRejectedValueOnce(new Error("gone")),
		});
		const described = card({ description: "x".repeat(200) });
		expect(await readyToStart(described)).toBe(true);
		expect(toastMock.toast).not.toHaveBeenCalled();
		expect(await readyToStart(described)).toBe(true);
		expect(await readyToStart(described)).toBe(true);
	});
});

describe("persistTaskStatus and the pre-analysis", () => {
	it("holds a first start without saving it, and passes when skipped", async () => {
		api = installRendererApi({
			checkTaskReadiness: vi.fn(async () => ({ success: true, data: notReady })),
			updateTaskStatus: vi.fn(async () => ({ success: true })),
		});
		useTaskStore.setState({ tasks: [card()] });
		expect(await persistTaskStatus("t1", "in_progress")).toEqual({ success: false, held: true });
		expect(api.fn("updateTaskStatus")).not.toHaveBeenCalled();
		expect(await persistTaskStatus("t1", "in_progress", { skipReadiness: true })).toEqual({ success: true });
		expect(api.fn("updateTaskStatus")).toHaveBeenCalledWith("t1", "in_progress", {});
		await persistTaskStatus("t1", "done", { forceCleanup: true });
		expect(api.fn("updateTaskStatus")).toHaveBeenLastCalledWith("t1", "done", { forceCleanup: true });
	});
});
