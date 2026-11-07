/**
 * A « Build rouge » task restored into the state machine (after a restart):
 * resuming it — by hand or by the CI repair loop — must start the run.
 */
import { describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

const persisted: string[] = [];
vi.mock("../ipc-handlers/task/plan-file-utils", () => ({
	getPlanPath: () => "/nowhere/implementation_plan.json",
	persistPlanStatusAndReasonSync: (_p: string, status: string) => {
		persisted.push(status);
		return true;
	},
}));
vi.mock("../ipc-handlers/utils", () => ({ safeSendToRenderer: vi.fn() }));
vi.mock("../worktree-paths", () => ({ findTaskWorktree: () => null }));

describe("build_failed task in the state machine", () => {
	it("resumes into coding instead of being ignored", async () => {
		const { taskStateManager } = await import("../task-state-manager");
		const task = {
			id: "red-1",
			specId: "001-red",
			status: "build_failed",
			subtasks: [{ id: "s1", status: "completed" }],
			metadata: {},
		} as unknown as Task;
		const project = { id: "p1", path: "/nowhere", autoBuildPath: ".workpilot" } as Project;

		taskStateManager.handleUiEvent("red-1", { type: "USER_RESUMED" }, task, project);

		expect(taskStateManager.getCurrentState("red-1")).toBe("coding");
		expect(persisted.at(-1)).toBe("in_progress");
	});
});
