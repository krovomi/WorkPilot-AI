/**
 * A task the backend paused by itself (its cost budget, or the circuit
 * breaker of #353) keeps its column on exit, and the person is told why.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../shared/types";

const announce = vi.fn();
const handleProcessExited = vi.fn();
let paused = true;
const found: { task?: Task; project?: Project } = {};

vi.mock("../../backend-pause-notify", () => ({
	announceBackendPause: (...args: unknown[]) => announce(...args),
}));
vi.mock("../../file-watcher", () => ({
	fileWatcher: {
		getCurrentPlan: () => (paused ? { paused: { enabled: true } } : null),
		on: vi.fn(),
		unwatch: vi.fn(),
	},
}));
vi.mock("../../task-state-manager", () => ({
	taskStateManager: {
		configure: vi.fn(),
		handleProcessExited: (...args: unknown[]) => handleProcessExited(...args),
	},
}));
vi.mock("../../claude-profile-manager", () => ({ getClaudeProfileManager: vi.fn() }));
vi.mock("../../title-generator", () => ({ titleGenerator: { on: vi.fn() } }));
vi.mock("../../worktree-paths", () => ({ findTaskWorktree: () => null }));
vi.mock("../task/shared", () => ({ findTaskAndProject: () => ({ ...found }) }));
vi.mock("../task/best-of-n-handlers", () => ({ isBestOfNVariant: () => false }));
vi.mock("../bench-handlers", () => ({ isBenchBuild: () => false }));
vi.mock("../task-permission-handlers", () => ({
	clearTaskPermissions: vi.fn(),
	handlePermissionTaskEvent: vi.fn(),
}));
vi.mock("../utils", () => ({ safeSendToRenderer: vi.fn() }));

import type { AgentManager } from "../../agent";
import { registerAgenteventsHandlers } from "../agent-events-handlers";

const project = { id: "proj-1", name: "P", path: "/work/repo", autoBuildPath: ".workpilot" } as unknown as Project;
const task = { id: "t1", specId: "001-a", projectId: "proj-1", title: "Add login" } as unknown as Task;

function exit() {
	const agents = new EventEmitter();
	registerAgenteventsHandlers(agents as unknown as AgentManager, () => null);
	agents.emit("exit", "t1", 0, "task-execution", "proj-1");
}

beforeEach(() => {
	announce.mockReset();
	handleProcessExited.mockReset();
	paused = true;
	found.task = task;
	found.project = project;
});

describe("exit of a task the backend paused", () => {
	it("keeps the card where it is and announces the pause from its spec directory", () => {
		exit();
		expect(handleProcessExited).not.toHaveBeenCalled();
		expect(announce).toHaveBeenCalledWith("proj-1", expect.stringContaining("001-a"), "Add login");
	});

	it("announces nothing for a task it cannot find", () => {
		found.task = undefined;
		exit();
		expect(announce).not.toHaveBeenCalled();
	});

	it("leaves an exit that is not a pause to the state machine", () => {
		paused = false;
		exit();
		expect(announce).not.toHaveBeenCalled();
		expect(handleProcessExited).toHaveBeenCalled();
	});
});
