/** The QA review of a green card started again, as from the board. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

const state = vi.hoisted(() => ({
	init: { success: true, profileManager: { hasValidAuth: () => true } } as unknown,
	needsAuth: false,
	handled: true,
}));
const persistPlanStatus = vi.fn();
const watch = vi.fn();
const ensureTaskEngine = vi.fn();
const invalidate = vi.fn();

vi.mock("../../ipc-handlers/task/execution-utils", () => ({
	ensureProfileManagerInitialized: async () => state.init,
	ensureTaskEngine: (...a: unknown[]) => ensureTaskEngine(...a),
	requiresClaudeAuth: () => state.needsAuth,
}));
vi.mock("../../ipc-handlers/task/plan-file-utils", () => ({
	getPlanPath: () => "/p/.workpilot/specs/001-x/implementation_plan.json",
	persistPlanStatus: (...a: unknown[]) => persistPlanStatus(...a),
}));
vi.mock("../../file-watcher", () => ({ fileWatcher: { watch: (...a: unknown[]) => watch(...a) } }));
vi.mock("../../project-store", () => ({ projectStore: { invalidateTasksCache: (...a: unknown[]) => invalidate(...a) } }));
vi.mock("../../task-state-manager", () => ({
	taskStateManager: { handleManualStatusChange: () => state.handled },
}));

const { rerunQaReview } = await import("../qa-rerun");

const task = { id: "t1", specId: "001-x" } as Task;
const project = { id: "p1", path: "/p", autoBuildPath: ".workpilot" } as Project;

function agents(running = false) {
	return { isRunning: vi.fn(() => running), startQAProcess: vi.fn(async () => undefined) };
}

beforeEach(() => {
	state.init = { success: true, profileManager: { hasValidAuth: () => true } };
	state.needsAuth = false;
	state.handled = true;
	for (const spy of [persistPlanStatus, watch, ensureTaskEngine, invalidate]) spy.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("rerunQaReview", () => {
	it("starts QA and tells the window", async () => {
		const manager = agents();
		const send = vi.fn();
		const ok = await rerunQaReview(task, project, manager as never, () => ({ webContents: { send } }) as never);
		expect(ok).toBe(true);
		expect(manager.startQAProcess).toHaveBeenCalledWith("t1", "/p", "001-x", "p1");
		expect(watch).toHaveBeenCalledOnce();
		expect(persistPlanStatus).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith("task:statusChange", "t1", "ai_review", "p1");
	});

	it("writes the status itself when the state machine does not", async () => {
		state.handled = false;
		expect(await rerunQaReview(task, project, agents() as never, () => null)).toBe(true);
		expect(persistPlanStatus).toHaveBeenCalledWith(expect.any(String), "ai_review", "p1", "system");
	});

	it("does nothing while the card runs, without profiles or without a sign-in", async () => {
		expect(await rerunQaReview(task, project, agents(true) as never, () => null)).toBe(false);
		state.init = { success: false, error: "x" };
		expect(await rerunQaReview(task, project, agents() as never, () => null)).toBe(false);
		state.init = { success: true, profileManager: { hasValidAuth: () => false } };
		state.needsAuth = true;
		const manager = agents();
		expect(await rerunQaReview(task, project, manager as never, () => null)).toBe(false);
		expect(manager.startQAProcess).not.toHaveBeenCalled();
	});
});
