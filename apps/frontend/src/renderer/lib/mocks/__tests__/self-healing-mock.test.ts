/**
 * The browser preview's self-healing API: an empty dashboard, and every
 * action and listener answering without a desktop app behind it.
 */
import { describe, expect, it } from "vitest";
import { selfHealingMock } from "../self-healing-mock";

describe("self-healing mock", () => {
	it("answers every call", async () => {
		const api = selfHealingMock.selfHealing as unknown as Record<string, (...args: unknown[]) => unknown>;
		expect(await api.getDashboard("/p")).toEqual({ success: false });
		expect(await api.getIncidents("/p")).toEqual({ success: true, data: [] });
		expect(await api.getOperations("/p")).toEqual({ success: true, data: [] });
		expect(await api.getFragility("/p")).toEqual({ success: true, data: [] });
		expect(await api.bisectIncident("/p", "inc1")).toEqual({
			success: false,
			error: "Not available in browser mode",
		});
		for (const name of ["onOperationProgress", "onOperationComplete", "onBisectProgress"]) {
			const stop = api[name](() => undefined) as () => void;
			expect(stop()).toBeUndefined();
		}
	});
});
