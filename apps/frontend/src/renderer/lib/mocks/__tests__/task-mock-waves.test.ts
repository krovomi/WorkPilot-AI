/**
 * The browser preview has no worktree to read: the plan says so instead of
 * inventing waves.
 */
import { describe, expect, it } from "vitest";
import { taskMock } from "../task-mock";

describe("taskMock.planExecutionWaves", () => {
	it("reports the feature unavailable in the browser preview", async () => {
		expect(await taskMock.planExecutionWaves()).toEqual({
			success: false,
			error: "Execution waves are not available in the browser preview",
		});
	});
});
