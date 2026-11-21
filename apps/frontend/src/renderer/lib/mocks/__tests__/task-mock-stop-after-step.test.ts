/** The browser preview has no running agent: the spoken stop finds nothing to stop. */
import { describe, expect, it } from "vitest";
import { taskMock } from "../task-mock";

describe("taskMock.stopAgentsAfterStep", () => {
	it("stops nothing in the browser preview", async () => {
		expect(await taskMock.stopAgentsAfterStep()).toEqual({
			success: true,
			data: { stoppingTasks: [], failedTasks: [] },
		});
	});
});
