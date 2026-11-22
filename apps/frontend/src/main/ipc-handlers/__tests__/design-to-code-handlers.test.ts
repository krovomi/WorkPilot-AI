/**
 * The loop's figures are asked for by project id: an id that names no
 * project reads nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	project: "",
}));

vi.mock("electron", () => ({
	app: { getPath: () => "/tmp", getAppPath: () => "/tmp", isPackaged: false },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => (id === "p1" ? { id: "p1", path: state.project } : undefined),
		getProjects: () => [{ id: "p1", path: state.project }],
	},
}));
vi.mock("../../python-env-manager", () => ({ pythonEnvManager: {} }));
vi.mock("../../updater/path-resolver", () => ({ getEffectiveSourcePath: () => "/tmp" }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: () => ({}) }));

import { recordLoop } from "../../design-loop-history";
import { registerDesignToCodeHandlers } from "../design-to-code-handlers";

afterEach(() => {
	if (state.project) rmSync(state.project, { recursive: true, force: true });
});

describe("DESIGN_TO_CODE_LOOP_STATS", () => {
	it("reads the figures of the project the id names, and none otherwise", async () => {
		state.project = mkdtempSync(path.join(tmpdir(), "dtc-stats-"));
		registerDesignToCodeHandlers();
		recordLoop(state.project, {
			status: "converged",
			best_iteration: 1,
			iterations: [{ score: 0.8 }, { score: 0.97 }],
		});
		const handler = state.handlers.get(IPC_CHANNELS.DESIGN_TO_CODE_LOOP_STATS);
		expect(await handler?.({}, "p1")).toMatchObject({ loops: 1, converged: 1 });
		expect(await handler?.({}, "/etc")).toMatchObject({ loops: 0, writes: 0 });
	});
});
