/**
 * The CI/CD store's rollback of a watched deployment (#366).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCICDTriggersStore } from "../cicd-triggers-store";

const rollbackDeployment = vi.fn();
const invoke = vi.fn();

beforeEach(() => {
	rollbackDeployment.mockReset();
	invoke.mockReset();
	invoke.mockResolvedValue({ success: true, data: [{ id: "42" }] });
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { rollbackDeployment, invoke };
	useCICDTriggersStore.setState({ error: null, rollingBack: null, runs: [] });
});

describe("rollback", () => {
	it("rolls back, then reads the runs again", async () => {
		rollbackDeployment.mockResolvedValue({ success: true });
		const pending = useCICDTriggersStore.getState().rollback("/p", "42");
		expect(useCICDTriggersStore.getState().rollingBack).toBe("42");
		expect(await pending).toBe(true);
		expect(rollbackDeployment).toHaveBeenCalledWith("/p", "42");
		expect(invoke).toHaveBeenCalledWith("cicdTriggers:listRuns", "/p", 50);
		expect(useCICDTriggersStore.getState()).toMatchObject({ rollingBack: null, runs: [{ id: "42" }] });
	});

	it("keeps the main's reason, or says it failed", async () => {
		rollbackDeployment.mockResolvedValueOnce({ success: false, error: "watch-running" });
		expect(await useCICDTriggersStore.getState().rollback("/p", "42")).toBe(false);
		expect(useCICDTriggersStore.getState().error).toBe("watch-running");
		rollbackDeployment.mockResolvedValueOnce({ success: false });
		await useCICDTriggersStore.getState().rollback("/p", "42");
		expect(useCICDTriggersStore.getState().error).toBe("Rollback failed");
	});

	it("reports a bridge that throws", async () => {
		rollbackDeployment.mockRejectedValueOnce(new Error("bridge down"));
		expect(await useCICDTriggersStore.getState().rollback("/p", "42")).toBe(false);
		expect(useCICDTriggersStore.getState()).toMatchObject({
			error: "Error: bridge down",
			rollingBack: null,
		});
	});
});
