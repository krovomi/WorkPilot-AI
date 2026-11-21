/**
 * The browser preview has no worktree to read: the plan says so instead of
 * inventing waves.
 */
import { describe, expect, it } from "vitest";
import { taskMock } from "../task-mock";

describe("taskMock snapshots", () => {
	it("lists none and restores nothing in the browser preview", async () => {
		expect(await taskMock.listTaskSnapshots()).toEqual({ success: true, data: [] });
		expect((await taskMock.restoreTaskSnapshot()).success).toBe(false);
	});
});

describe("taskMock.planExecutionWaves", () => {
	it("reports the feature unavailable in the browser preview", async () => {
		expect(await taskMock.planExecutionWaves()).toEqual({
			success: false,
			error: "Execution waves are not available in the browser preview",
		});
	});
});

describe("taskMock execution wave run", () => {
	it("has no saved run to resume and accepts saves in the browser preview", async () => {
		expect(await taskMock.loadExecutionWaveRun()).toEqual({ success: true, data: { run: null, ignored: false } });
		expect(await taskMock.saveExecutionWaveRun()).toEqual({ success: true });
		expect(await taskMock.clearExecutionWaveRun()).toEqual({ success: true });
	});
});
