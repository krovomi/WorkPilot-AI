import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AppState } from "react-native";
import type { ExecutionWavePlan, WaveHistory, WaveRunAnswer } from "../../api/types";
import { confirmAlerts } from "../../../test-support/admin-fixtures";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const BASE = "/api/features/execution-waves";
const RUNNER = ["board.read", "task.read", "task.write", "agent.execute"];
const READER = ["board.read", "task.read"];

const PLAN: ExecutionWavePlan = {
	maxParallel: 3,
	waves: [
		{ index: 1, taskIds: ["001-a", "002-b"], residualRisk: 0 },
		{ index: 2, taskIds: ["003-c", "004-x"], residualRisk: 1 },
	],
	tasks: [
		{ taskId: "001-a", title: "Add login", planned: true },
		{ taskId: "002-b", title: "Fix footer", planned: true },
		{ taskId: "003-c", title: "Rework auth", planned: false },
		{ taskId: "005-d", title: "Loop one", planned: true },
	],
	cycles: [["005-d", "006-e"]],
	excluded: [
		{ taskId: "005-d", reason: "cycle" },
		{ taskId: "007-z", reason: "blocked_by_cycle" },
	],
	totalRisk: 5,
	residualRisk: 1,
	mergeChecks: { checked: 2, conflicts: 1 },
};

const EMPTY_PLAN: ExecutionWavePlan = {
	maxParallel: 3,
	waves: [],
	tasks: [],
	cycles: [],
	excluded: [],
	totalRisk: 0,
	residualRisk: 0,
	mergeChecks: { checked: 0, conflicts: 0 },
};

const HISTORY: WaveHistory = {
	ignored: false,
	summary: {
		days: 14,
		runs: 2,
		stopped: 1,
		conflictsAvoided: 3,
		riskAvoided: 4,
		started: 5,
		lastFinishedAt: "2026-11-20T10:00:00Z",
	},
	conflicts: { ignored: false, resolved: 3, medianSeconds: 3 * 3600 + 5 * 60, open: 1 },
};

const NO_HISTORY: WaveHistory = {
	ignored: true,
	summary: { days: 14, runs: 0, stopped: 0, conflictsAvoided: 0, riskAvoided: 0, started: 0, lastFinishedAt: null },
	conflicts: { ignored: true, resolved: 0, medianSeconds: null, open: 0 },
};

const RUN = {
	waves: [
		["001-a", "002-b"],
		["003-c", "009-q", "010-r"],
	],
	current: 0,
	advanceWhen: "merged" as const,
	maxParallel: 3,
	started: ["001-a"],
	failures: { "002-b": "needs_approval" as const },
	savedAt: "2026-11-22T09:00:00Z",
};

const ANSWER: WaveRunAnswer = {
	run: RUN,
	cards: [
		{ id: "001-a", title: "Add login", column: "in_progress", running: true },
		{ id: "002-b", title: "Fix footer", column: "backlog", running: false },
		{ id: "003-c", title: "Rework auth", column: "backlog", running: false },
		{ id: "009-q", title: "Archived one", column: null, running: false },
	],
	blocked: ["003-c"],
	ended: null,
	ignored: false,
};

const NONE: WaveRunAnswer = { run: null, ended: null, ignored: false };

beforeEach(() => {
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("execution waves", () => {
	it("plans the backlog, starts a run, takes its steps and stops it", async () => {
		let current: WaveRunAnswer = { ...NONE, ignored: true };
		const server = fakeServer(
			{
				[`GET ${BASE}/plan`]: PLAN,
				[`GET ${BASE}/run`]: () => current,
				[`POST ${BASE}/run`]: () => {
					current = ANSWER;
					return ANSWER;
				},
				[`POST ${BASE}/run/step`]: ANSWER,
				[`DELETE ${BASE}/run`]: () => {
					current = NONE;
					return { run: null, ended: "stopped", ignored: false };
				},
				[`GET ${BASE}/history`]: HISTORY,
			},
			RUNNER,
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByText("Plan: 2 waves, up to 3 at a time")).toBeTruthy();
		expect(screen.getByText("The saved run could not be read, so it was set aside.")).toBeTruthy();
		expect(screen.getByText("Conflict risk avoided: 4 of 5")).toBeTruthy();
		expect(screen.getByText("Trial merges: 2 checked, 1 in conflict")).toBeTruthy();
		expect(screen.getByText("Loop one · in a dependency loop")).toBeTruthy();
		expect(screen.getByText("007-z · depends on a card in a loop")).toBeTruthy();
		expect(screen.getAllByTestId("waves-plan-wave")).toHaveLength(2);
		// A card the plan has no title for is named by its id.
		expect(screen.getByText("004-x")).toBeTruthy();
		expect(screen.getByTestId("waves-history").props.children).toBe(
			"Runs: 2 (stopped: 1) · conflicts avoided: 3 · risk avoided: 4 · cards started: 5",
		);
		expect(screen.getByText(/^Last run finished /)).toBeTruthy();
		expect(screen.getByTestId("waves-conflicts").props.children).toBe(
			"Merge conflicts resolved: 3, median time to resolve 3 h 05 min · still open: 1",
		);
		// Opening the page with no run takes no step.
		expect(server.called(`POST ${BASE}/run/step`)).toHaveLength(0);

		await fireEvent.press(screen.getByRole("button", { name: "Next wave once in review" }));
		expect(screen.getByRole("button", { name: "Next wave once in review" }).props.accessibilityState).toMatchObject({
			selected: true,
		});
		await fireEvent.press(screen.getByRole("button", { name: "Start the first wave" }));
		await waitFor(() => expect(server.called(`POST ${BASE}/run`)).toHaveLength(1));
		expect(server.called(`POST ${BASE}/run`)[0].body).toEqual({ advanceWhen: "review" });
		expect(server.called(`POST ${BASE}/run`)[0].query.get("project_id")).toBe("p1");

		// The screen reads again, and the run going on takes its next step.
		expect(await screen.findByText("Wave 1 of 2")).toBeTruthy();
		await waitFor(() => expect(server.called(`POST ${BASE}/run/step`)).toHaveLength(1));
		expect(screen.getByText("Next wave once merged")).toBeTruthy();
		expect(screen.getAllByTestId("waves-run-wave")).toHaveLength(2);
		expect(screen.getByText("Add login · In Progress · agent running")).toBeTruthy();
		expect(screen.getByText("Fix footer · waits for its spec to be approved")).toBeTruthy();
		expect(screen.getByText("Rework auth · waits for a card it depends on")).toBeTruthy();
		expect(screen.getByText("Archived one · no longer on the board")).toBeTruthy();
		expect(screen.getByText("010-r · no longer on the board")).toBeTruthy();

		await fireEvent.press(screen.getByRole("button", { name: "Check now" }));
		await waitFor(() => expect(server.called(`POST ${BASE}/run/step`)).toHaveLength(3));

		const alert = confirmAlerts();
		await fireEvent.press(screen.getByRole("button", { name: "Stop the run" }));
		expect(alert.mock.calls[0][0]).toBe("Stop the run?");
		await waitFor(() => expect(server.called(`DELETE ${BASE}/run`)).toHaveLength(1));
		expect(await screen.findByRole("button", { name: "Start the first wave" })).toBeTruthy();
	});

	it("shows a run past its last wave to someone who may only read it, and takes no step", async () => {
		const server = fakeServer(
			{
				[`GET ${BASE}/plan`]: EMPTY_PLAN,
				[`GET ${BASE}/run`]: { run: { ...RUN, current: 2, failures: {} }, ended: null, ignored: false },
				[`GET ${BASE}/history`]: NO_HISTORY,
			},
			READER,
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByText("Wave 2 of 2")).toBeTruthy();
		// The answer names no card: each one is shown by its id.
		expect(screen.getByText("001-a · no longer on the board")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Stop the run" })).toBeNull();
		expect(screen.queryByText(/^Conflict risk avoided/)).toBeNull();
		expect(screen.queryByText(/^Trial merges/)).toBeNull();
		expect(screen.getByText("The run history could not be read.")).toBeTruthy();
		expect(screen.getByText("The merge conflict times could not be read.")).toBeTruthy();
		expect(screen.queryByText(/^Last run finished /)).toBeNull();
		expect(server.called(`POST ${BASE}/run/step`)).toHaveLength(0);
	});

	it("stops nothing for someone who may start agents but not write tasks", async () => {
		fakeServer(
			{
				[`GET ${BASE}/plan`]: PLAN,
				[`GET ${BASE}/run`]: ANSWER,
				[`POST ${BASE}/run/step`]: ANSWER,
				[`GET ${BASE}/history`]: HISTORY,
			},
			["board.read", "task.read", "agent.execute"],
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByRole("button", { name: "Check now" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Stop the run" })).toBeNull();
	});

	it("tells someone without the right to start agents, and says when a run finished", async () => {
		fakeServer(
			{
				[`GET ${BASE}/plan`]: PLAN,
				[`GET ${BASE}/run`]: { run: null, ended: "done", ignored: false },
				[`GET ${BASE}/history`]: {
					...HISTORY,
					conflicts: { ignored: false, resolved: 0, medianSeconds: null, open: 0 },
				},
			},
			READER,
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByText("You don't have the rights to start agents on this project.")).toBeTruthy();
		expect(screen.getByText("The last run went through all its waves.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start the first wave" })).toBeNull();
		expect(screen.queryByTestId("waves-conflicts")).toBeNull();
	});

	it("says when there is nothing to plan, and shows a start the server refuses", async () => {
		fakeServer(
			{
				[`GET ${BASE}/plan`]: { ...EMPTY_PLAN, waves: [{ index: 1, taskIds: ["001-a"], residualRisk: 0 }] },
				[`GET ${BASE}/run`]: NONE,
				[`POST ${BASE}/run`]: reply(409, { detail: "Nothing to plan" }),
				[`GET ${BASE}/history`]: HISTORY,
			},
			RUNNER,
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByText("Plan: 1 wave, up to 3 at a time")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Start the first wave" }));
		expect(await screen.findByText("Something went wrong: Nothing to plan")).toBeTruthy();
	});

	it("says the backlog is empty, and times a short conflict in minutes", async () => {
		const history = { ...HISTORY, conflicts: { ignored: false, resolved: 1, medianSeconds: 20, open: 0 } };
		fakeServer(
			{ [`GET ${BASE}/plan`]: EMPTY_PLAN, [`GET ${BASE}/run`]: NONE, [`GET ${BASE}/history`]: history },
			RUNNER,
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByText("Nothing in Planning or Queue to plan.")).toBeTruthy();
		expect(screen.getByTestId("waves-conflicts").props.children).toBe(
			"Merge conflicts resolved: 1, median time to resolve 1 min · still open: 0",
		);
	});

	it("counts open conflicts when none was resolved, and shows nothing without one", async () => {
		const history = { ...HISTORY, conflicts: { ignored: false, resolved: 0, medianSeconds: null, open: 2 } };
		fakeServer(
			{ [`GET ${BASE}/plan`]: EMPTY_PLAN, [`GET ${BASE}/run`]: NONE, [`GET ${BASE}/history`]: history },
			RUNNER,
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByText("No merge conflict resolved · still open: 2")).toBeTruthy();
	});

	it("shows a plan that cannot be read", async () => {
		fakeServer(
			{
				[`GET ${BASE}/plan`]: reply(500, { detail: "clone missing" }),
				[`GET ${BASE}/run`]: NONE,
				[`GET ${BASE}/history`]: HISTORY,
			},
			RUNNER,
		);
		await openApp("/projects/p1/waves");
		expect(await screen.findByText("Something went wrong: clone missing")).toBeTruthy();
		expect(screen.queryByText(/^Plan:/)).toBeNull();
	});

	it("is a link of the board for someone who may read tasks", async () => {
		fakeServer(
			{
				"GET /api/board/cards": { cards: [] },
				"GET /projects/p1": { id: "p1", name: "Shop", repo_url: "", default_branch: "main", forge: null },
				[`GET ${BASE}/plan`]: EMPTY_PLAN,
				[`GET ${BASE}/run`]: NONE,
				[`GET ${BASE}/history`]: HISTORY,
			},
			READER,
		);
		const app = await openApp("/projects/p1");
		await fireEvent.press(await screen.findByText("Waves"));
		await waitFor(() => expect(app.getPathname()).toBe("/projects/p1/waves"));
	});
});
