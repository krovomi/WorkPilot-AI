/**
 * The waves of a server project (#358), from the person's side: the server's
 * plan, the run going on (each card's column or why it waits), starting,
 * stepping and stopping the run for those who may, and the figures of the
 * last days as the server counted and measured them. `window.electronAPI`
 * stands in for the main process.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Project } from "../../../../shared/types";
import type {
	ServerWaveHistory,
	ServerWavePlan,
	ServerWaveRun,
	ServerWaveRunAnswer,
} from "../../../../shared/types/server-conflict-waves";
import { usePermissionsStore } from "../../../stores/permissions-store";
import { ServerHistoryPanel, ServerPlanPanel, ServerRunPanel } from "../ServerWavesParts";
import { loadServerWaves, ServerWavesView } from "../ServerWavesView";

function project(role: "viewer" | "member" | "owner" = "member"): Project {
	return {
		id: "p-1",
		name: "Shop",
		path: "/mirror/p-1",
		remote: { repoUrl: "https://x/r.git", defaultBranch: "main", role },
	} as unknown as Project;
}

function plan(extra: Partial<ServerWavePlan> = {}): ServerWavePlan {
	return {
		maxParallel: 2,
		waves: [
			{ index: 1, taskIds: ["001-a", "002-b"], residualRisk: 0 },
			{ index: 2, taskIds: ["003-c"], residualRisk: 0 },
		],
		tasks: [
			{ taskId: "001-a", title: "Login", planned: true, fileCount: 3 },
			{ taskId: "002-b", title: "Search", planned: true, fileCount: 1 },
			{ taskId: "003-c", title: "Cart", planned: false, fileCount: 0 },
		],
		excluded: [],
		cycles: 0,
		totalRisk: 6,
		residualRisk: 1,
		mergeChecks: { checked: 0, conflicts: 0 },
		...extra,
	};
}

const run: ServerWaveRun = {
	waves: [["001-a", "002-b"], ["003-c"], ["004-d"]],
	current: 1,
	advanceWhen: "merged",
	maxParallel: 2,
	started: ["001-a", "002-b", "003-c"],
	failures: { "004-d": "quota" },
	savedAt: "2026-11-22T10:00:00+00:00",
};

const going: ServerWaveRunAnswer = {
	run,
	cards: [
		{ id: "001-a", title: "Login", column: "done", running: false },
		{ id: "002-b", title: "Search", column: null, running: false },
		{ id: "003-c", title: "Cart", column: "in_progress", running: true },
	],
	blocked: [],
	ended: null,
	ignored: false,
};

const idle: ServerWaveRunAnswer = { run: null, cards: [], blocked: [], ended: null, ignored: false };

function history(extra: Partial<ServerWaveHistory> = {}): ServerWaveHistory {
	return {
		ignored: false,
		summary: {
			days: 14,
			runs: 3,
			stopped: 1,
			conflictsAvoided: 4,
			riskAvoided: 9,
			started: 7,
			lastFinishedAt: null,
		},
		conflicts: { ignored: false, resolved: 2, medianSeconds: 900, open: 1 },
		...extra,
	};
}

const ok = <T,>(data: T) => ({ success: true, data });
let api: Record<string, ReturnType<typeof vi.fn>>;

function allow(...permissions: string[]) {
	usePermissionsStore.setState({ unrestricted: false, isPlatformAdmin: false, permissions: new Set(permissions) });
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	allow("task.read", "task.write", "agent.execute");
	api = {
		getServerWavePlan: vi.fn().mockResolvedValue(ok(plan())),
		getServerWaveRun: vi.fn().mockResolvedValue(ok(idle)),
		getServerWaveHistory: vi.fn().mockResolvedValue(ok(history())),
		startServerWaveRun: vi.fn().mockResolvedValue(ok(going)),
		stepServerWaveRun: vi.fn().mockResolvedValue(ok(going)),
		stopServerWaveRun: vi.fn().mockResolvedValue(ok({ ...idle, ended: "stopped" })),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});
afterEach(cleanup);

describe("loadServerWaves", () => {
	it("says which read failed, and steps a run only when asked", async () => {
		api.getServerWavePlan.mockResolvedValueOnce({ success: false });
		expect(await loadServerWaves("p-1", true)).toEqual({ data: null, error: "", failure: null });
		api.getServerWaveRun.mockResolvedValueOnce({ success: false, error: "Not a project of the server" });
		expect((await loadServerWaves("p-1", true)).error).toBe("Not a project of the server");
		api.getServerWaveHistory.mockResolvedValueOnce({ success: true });
		expect((await loadServerWaves("p-1", true)).error).toBe("");

		api.getServerWaveRun.mockResolvedValue(ok(going));
		expect((await loadServerWaves("p-1", false)).data?.run).toBe(going);
		expect(api.stepServerWaveRun).not.toHaveBeenCalled();
		const stepped = { ...going, blocked: ["003-c"] };
		api.stepServerWaveRun.mockResolvedValueOnce(ok(stepped));
		expect((await loadServerWaves("p-1", true)).data?.run).toBe(stepped);
		api.stepServerWaveRun.mockResolvedValueOnce({ success: false, error: "Permission denied" });
		expect(await loadServerWaves("p-1", true)).toMatchObject({ error: null, failure: "Permission denied" });
	});
});

describe("ServerWavesView", () => {
	it("shows the plan and the figures, and starts the first wave with the rule chosen", async () => {
		render(<ServerWavesView project={project()} />);
		expect(screen.getByText("Reading the server's waves…")).toBeTruthy();
		const plan = await screen.findByTestId("server-wave-plan");
		expect(within(plan).getByText("Plan: 2 waves, up to 2 at a time")).toBeTruthy();
		expect(within(screen.getByTestId("server-wave-1")).getByText("Search")).toBeTruthy();
		expect(screen.getByTestId("server-wave-history").textContent).toContain("Runs: 3 (stopped: 1)");
		// Nothing goes on: opening the view takes no step.
		expect(api.stepServerWaveRun).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText("once the wave is in review"));
		api.getServerWaveRun.mockResolvedValue(ok(going));
		fireEvent.click(screen.getByText("Start the first wave"));
		await screen.findByTestId("server-wave-run");
		expect(api.startServerWaveRun).toHaveBeenCalledWith("p-1", "review");
		// The reload after an action takes no second step.
		expect(api.stepServerWaveRun).not.toHaveBeenCalled();
	});

	it("takes the run's next step on opening, then steps and stops it on demand", async () => {
		api.getServerWaveRun.mockResolvedValue(ok(going));
		render(<ServerWavesView project={project("owner")} />);
		await screen.findByTestId("server-wave-run");
		expect(api.stepServerWaveRun).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByText("Check now"));
		await waitFor(() => expect(api.stepServerWaveRun).toHaveBeenCalledTimes(2));

		fireEvent.click(screen.getByText("Stop the run"));
		expect(screen.getByText(/The cards it started keep running/)).toBeTruthy();
		fireEvent.click(screen.getByText("Cancel"));
		expect(screen.queryByText(/The cards it started keep running/)).toBeNull();
		fireEvent.click(screen.getByText("Stop the run"));
		api.getServerWaveRun.mockResolvedValue(ok({ ...idle, ended: "stopped" }));
		fireEvent.click(within(screen.getByRole("alert")).getByText("Stop the run"));
		await screen.findByTestId("server-wave-execute");
		expect(api.stopServerWaveRun).toHaveBeenCalledWith("p-1");
	});

	it("says what the server refused", async () => {
		api.getServerWaveRun.mockResolvedValue(ok(going));
		api.stepServerWaveRun.mockResolvedValue({ success: false, error: "Run file unavailable" });
		render(<ServerWavesView project={project()} />);
		expect(await screen.findByText("The server did not do it: Run file unavailable")).toBeTruthy();
		fireEvent.click(screen.getByText("Check now"));
		await waitFor(() => expect(api.stepServerWaveRun).toHaveBeenCalledTimes(2));
		expect(screen.getByText("The server did not do it: Run file unavailable")).toBeTruthy();
	});

	it("says when the waves could not be read, and reads them again on demand", async () => {
		api.getServerWavePlan.mockResolvedValueOnce({ success: false, error: "Not authenticated" });
		render(<ServerWavesView project={project()} />);
		expect(await screen.findByText("Could not read the server's waves: Not authenticated")).toBeTruthy();
		expect(screen.queryByText("Reading the server's waves…")).toBeNull();
		fireEvent.click(screen.getByText("Refresh"));
		await screen.findByTestId("server-wave-plan");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("offers no action to a viewer of the project, nor to someone without the rights", async () => {
		api.getServerWaveRun.mockResolvedValue(ok(going));
		render(<ServerWavesView project={project("viewer")} />);
		await screen.findByTestId("server-wave-run");
		expect(screen.queryByText("Check now")).toBeNull();
		expect(screen.queryByText("Stop the run")).toBeNull();
		expect(api.stepServerWaveRun).not.toHaveBeenCalled();
		cleanup();

		allow("task.read", "task.write");
		render(<ServerWavesView project={project()} />);
		await screen.findByTestId("server-wave-run");
		expect(screen.queryByText("Check now")).toBeNull();
		expect(screen.getByText("Stop the run")).toBeTruthy();
		cleanup();

		allow("task.read");
		api.getServerWaveRun.mockResolvedValue(ok({ ...idle, ended: "done", ignored: true }));
		render(<ServerWavesView project={project()} />);
		await screen.findByTestId("server-wave-execute");
		expect(screen.getByText("You don't have the rights to start agents on this project.")).toBeTruthy();
		expect(screen.getByText("The last run went through all its waves.")).toBeTruthy();
		expect(screen.getByText("The saved run could not be read, so it was set aside.")).toBeTruthy();
	});

	it("says there is nothing to plan", async () => {
		api.getServerWavePlan.mockResolvedValue(ok(plan({ waves: [], tasks: [], totalRisk: 0, residualRisk: 0 })));
		render(<ServerWavesView project={project()} />);
		expect(await screen.findByText("Nothing in Planning or Queue to plan.")).toBeTruthy();
		expect(screen.queryByText("Start the first wave")).toBeNull();
	});
});

describe("ServerRunPanel", () => {
	it("gives each card its column, or why it waits", () => {
		render(<ServerRunPanel answer={{ ...going, run, blocked: ["002-b"] }} />);
		const panel = screen.getByTestId("server-wave-run");
		expect(within(panel).getByText("Wave 2 of 3")).toBeTruthy();
		expect(within(panel).getByText("Next wave once merged")).toBeTruthy();
		const items = [...panel.querySelectorAll("li li")].map((li) => li.textContent);
		expect(items).toEqual([
			"Login · Done",
			"Search · waits for a card it depends on",
			"Cart · In Progress · agent running",
			"004-d · over the agent quota",
		]);
		expect([...panel.querySelectorAll("ol > li")].map((li) => li.getAttribute("data-state"))).toEqual([
			"finished",
			"current",
			"pending",
		]);
	});

	it("says a card left the board", () => {
		render(<ServerRunPanel answer={{ ...going, run: { ...run, current: 5, failures: {} } }} />);
		expect(screen.getByText("Wave 3 of 3")).toBeTruthy();
		expect(screen.getByText(/Search/).parentElement?.textContent).toBe("Search · no longer on the board");
	});
});

describe("ServerPlanPanel", () => {
	it("shows the trial merges and the cards left out of a loop", () => {
		render(
			<ServerPlanPanel
				plan={plan({
					mergeChecks: { checked: 3, conflicts: 1 },
					cycles: 1,
					excluded: [
						{ taskId: "001-a", reason: "cycle" },
						{ taskId: "009-z", reason: "blocked_by_cycle" },
					],
				})}
			/>,
		);
		expect(screen.getByText("Trial merges: 3 checked, 1 in conflict")).toBeTruthy();
		expect(screen.getByText("5 of 6")).toBeTruthy();
		const alert = screen.getByRole("alert");
		expect(within(alert).getByText("Login · in a dependency loop")).toBeTruthy();
		expect(within(alert).getByText("009-z · depends on a card in a loop")).toBeTruthy();
	});
});

describe("ServerHistoryPanel", () => {
	it("shows the measured median of the conflicts resolved, and the last run", () => {
		render(
			<ServerHistoryPanel history={history({ summary: { ...history().summary, lastFinishedAt: "2026-11-21T09:00:00Z" } })} />,
		);
		expect(screen.getByTestId("server-wave-conflicts").textContent).toBe(
			"Merge conflicts resolved: 2, median time to resolve 15 min · still open: 1",
		);
		expect(screen.getByText(/Last run finished/)).toBeTruthy();
	});

	it("says when nothing was resolved, when nothing happened, and when the files could not be read", () => {
		const { rerender } = render(
			<ServerHistoryPanel history={history({ conflicts: { ignored: false, resolved: 0, medianSeconds: null, open: 2 } })} />,
		);
		expect(screen.getByTestId("server-wave-conflicts").textContent).toBe("No merge conflict resolved · still open: 2");
		rerender(<ServerHistoryPanel history={history({ conflicts: { ignored: false, resolved: 0, medianSeconds: null, open: 0 } })} />);
		expect(screen.queryByTestId("server-wave-conflicts")).toBeNull();
		rerender(
			<ServerHistoryPanel
				history={history({ ignored: true, conflicts: { ignored: true, resolved: 0, medianSeconds: null, open: 0 } })}
			/>,
		);
		expect(screen.getByText("The run history could not be read.")).toBeTruthy();
		expect(screen.getByText("The merge conflict times could not be read.")).toBeTruthy();
		expect(screen.queryByText(/Last run finished/)).toBeNull();
	});
});
