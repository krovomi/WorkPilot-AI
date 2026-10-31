import { beforeEach, describe, expect, it } from "vitest";
import {
	buildViewUsageReport,
	rankViewUsage,
	useViewUsageStore,
} from "../view-usage-store";

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

	it("restarts the counting date on reset", () => {
		useViewUsageStore.getState().reset(1_000);
		expect(useViewUsageStore.getState().since).toBe(1_000);
		expect(localStorage.getItem("workpilot.viewUsage.since")).toBe("1000");
	});

	it("exports every experimental view, the ones never opened included", () => {
		const { enter } = useViewUsageStore.getState();
		enter("agent-replay", 0);
		enter("kanban", 1_000);
		enter(null, 2_000);
		const report = buildViewUsageReport(
			useViewUsageStore.getState().usage,
			0,
			["team-bot", "agent-replay", "changelog"],
			86_400_000,
		);
		expect(report.countingSince).toBe("1970-01-01T00:00:00.000Z");
		expect(report.exportedAt).toBe("1970-01-02T00:00:00.000Z");
		expect(report.experimental).toEqual([
			{ view: "agent-replay", visits: 1, dwellMs: 1_000 },
			{ view: "changelog", visits: 0, dwellMs: 0 },
			{ view: "team-bot", visits: 0, dwellMs: 0 },
		]);
		expect(report.neverOpened).toEqual(["changelog", "team-bot"]);
		expect(report.views.map((row) => row.view)).toEqual([
			"agent-replay",
			"kanban",
		]);
	});
});
