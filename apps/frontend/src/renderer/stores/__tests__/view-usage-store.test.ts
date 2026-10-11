import { beforeEach, describe, expect, it } from "vitest";
import { rankViewUsage, useViewUsageStore } from "../view-usage-store";

describe("view-usage-store", () => {
	beforeEach(() => useViewUsageStore.getState().reset());

	it("counts visits and sums dwell time per view", () => {
		const { enter } = useViewUsageStore.getState();
		enter("kanban", 0);
		enter("roadmap", 1000);
		enter("kanban", 4000);
		enter(null, 5000);
		const u = useViewUsageStore.getState().usage;
		expect(u.kanban).toMatchObject({ visits: 2, dwellMs: 2000 });
		expect(u.roadmap).toMatchObject({ visits: 1, dwellMs: 3000 });
	});

	it("ignores re-entering the view already on screen", () => {
		const { enter } = useViewUsageStore.getState();
		enter("kanban", 0);
		enter("kanban", 10);
		expect(useViewUsageStore.getState().usage.kanban?.visits).toBe(1);
	});

	it("caps a forgotten page at thirty minutes", () => {
		const { enter } = useViewUsageStore.getState();
		enter("kanban", 0);
		enter("roadmap", 10 * 60 * 60 * 1000);
		expect(useViewUsageStore.getState().usage.kanban?.dwellMs).toBe(1800000);
	});

	it("ranks by visits", () => {
		const { enter } = useViewUsageStore.getState();
		enter("roadmap", 0);
		enter("kanban", 1);
		enter("roadmap", 2);
		expect(rankViewUsage(useViewUsageStore.getState().usage)[0].view).toBe(
			"roadmap",
		);
	});
});
