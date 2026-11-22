/**
 * A server project's execution waves (#358), in server mode: read from the
 * server by project id, each answer rebuilt field by field before the
 * renderer sees it (closed lists, task ids of the planner's shape, bounded
 * numbers); the advance rule checked before anything is sent; a project the
 * server did not list refused before any request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { Project } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	getServerProject: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../server-projects", () => ({ getServerProject: mocks.getServerProject }));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
	},
}));

import { registerServerConflictWavesHandlers } from "../../ipc-handlers/server-conflict-waves-handlers";
import {
	fetchServerWaveHistory,
	fetchServerWavePlan,
	fetchServerWaveRun,
	historyFrom,
	planFrom,
	runAnswerFrom,
	runFrom,
	startServerWaveRun,
	stepServerWaveRun,
	stopServerWaveRun,
} from "../server-waves";

const shop = {
	id: "p-1",
	path: "/mirror/p-1",
	remote: { repoUrl: "https://x/r.git", defaultBranch: "main", role: "member" },
} as unknown as Project;

const serverPlan = {
	projectId: "p-1",
	maxParallel: 3,
	tolerance: 0,
	waves: [
		{ index: 1, taskIds: ["001-a", "002-b"], residualRisk: 0 },
		{ index: 2, taskIds: ["003-c"], residualRisk: 1.234 },
	],
	order: ["001-a", "002-b", "003-c"],
	tasks: [
		{ taskId: "001-a", title: "Login", status: "backlog", fileCount: 4, planned: true },
		{ taskId: "002-b", title: "", status: "queue", fileCount: 0, planned: false },
		{ taskId: "003-c", title: "Cart", status: "backlog", fileCount: 2.9, planned: true },
	],
	pairs: [{ a: "001-a", b: "003-c", score: 5 }],
	cycles: [["004-d", "005-e"]],
	excluded: [
		{ taskId: "004-d", reason: "cycle" },
		{ taskId: "006-f", reason: "blocked_by_cycle" },
	],
	totalRisk: 7.5,
	residualRisk: 1.234,
	mergeChecks: { checked: 2, conflicts: 1, unchecked: 0, failed: 0 },
};

const serverRun = {
	waves: [["001-a", "002-b"], ["003-c"]],
	current: 0,
	advanceWhen: "review",
	maxParallel: 2,
	started: ["001-a"],
	failures: { "002-b": "needs_approval" },
	savedAt: "2026-11-22T10:00:00+00:00",
};

const serverHistory = {
	records: [],
	ignored: false,
	summary: {
		days: 14,
		runs: 3,
		stopped: 1,
		conflictsAvoided: 4,
		riskAvoided: 9.5,
		started: 7,
		lastFinishedAt: "2026-11-21T09:00:00+00:00",
	},
	conflicts: { ignored: false, resolved: 2, medianSeconds: 900, open: 1 },
};

function answered(data: unknown) {
	mocks.authedFetch.mockResolvedValueOnce({ ok: true, data });
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.getServerProject.mockReset();
	mocks.handlers.clear();
});

describe("planFrom", () => {
	it("keeps what the view shows of the server's plan", () => {
		expect(planFrom(serverPlan)).toEqual({
			maxParallel: 3,
			waves: [
				{ index: 1, taskIds: ["001-a", "002-b"], residualRisk: 0 },
				{ index: 2, taskIds: ["003-c"], residualRisk: 1.23 },
			],
			tasks: [
				{ taskId: "001-a", title: "Login", planned: true, fileCount: 4 },
				{ taskId: "002-b", title: "002-b", planned: false, fileCount: 0 },
				{ taskId: "003-c", title: "Cart", planned: true, fileCount: 2 },
			],
			excluded: [
				{ taskId: "004-d", reason: "cycle" },
				{ taskId: "006-f", reason: "blocked_by_cycle" },
			],
			cycles: 1,
			totalRisk: 7.5,
			residualRisk: 1.23,
			mergeChecks: { checked: 2, conflicts: 1 },
		});
	});

	it("drops what is not of the planner's shape and renumbers the waves", () => {
		const plan = planFrom({
			maxParallel: 1e9,
			waves: [null, { taskIds: ["../etc", 3] }, { taskIds: ["007-g", "a/b"], residualRisk: -2 }],
			tasks: [null, { taskId: "x y" }, { taskId: "007-g", title: 5, fileCount: "4" }],
			excluded: [null, { taskId: "../x", reason: "cycle" }, { taskId: "007-g", reason: "other" }],
			cycles: [["a"], "b"],
			totalRisk: Number.POSITIVE_INFINITY,
			residualRisk: 1e12,
			mergeChecks: "many",
		});
		expect(plan).toEqual({
			maxParallel: 32,
			waves: [{ index: 1, taskIds: ["007-g"], residualRisk: 0 }],
			tasks: [{ taskId: "007-g", title: "007-g", planned: false, fileCount: 0 }],
			excluded: [],
			cycles: 1,
			totalRisk: 0,
			residualRisk: 1_000_000_000,
			mergeChecks: { checked: 0, conflicts: 0 },
		});
	});

	it("is null when the answer is not a plan", () => {
		expect(planFrom(null)).toBeNull();
		expect(planFrom([])).toBeNull();
		expect(planFrom({ waves: "1" })).toBeNull();
		expect(planFrom({ waves: [] })?.maxParallel).toBe(1);
	});
});

describe("runFrom", () => {
	it("keeps a coherent run", () => {
		expect(runFrom(serverRun)).toEqual({
			waves: [["001-a", "002-b"], ["003-c"]],
			current: 0,
			advanceWhen: "review",
			maxParallel: 2,
			started: ["001-a"],
			failures: { "002-b": "needs_approval" },
			savedAt: "2026-11-22T10:00:00+00:00",
		});
	});

	it("keeps only failures from the closed list, of cards in the run", () => {
		const run = runFrom({
			...serverRun,
			current: 9,
			started: ["001-a", "999-z", "../x"],
			failures: { "002-b": "rm -rf", "999-z": "quota", "003-c": "quota" },
			savedAt: "not a date",
			maxParallel: 0,
		});
		expect(run).toMatchObject({
			current: 2,
			started: ["001-a"],
			failures: { "003-c": "quota" },
			savedAt: null,
			maxParallel: 1,
		});
		expect(runFrom({ ...serverRun, failures: ["quota"], savedAt: 3 })).toMatchObject({ failures: {}, savedAt: null });
	});

	it("is null for a run with no wave or an unknown advance rule", () => {
		expect(runFrom("run")).toBeNull();
		expect(runFrom({ ...serverRun, advanceWhen: "always" })).toBeNull();
		expect(runFrom({ ...serverRun, waves: [[], ["../x"]] })).toBeNull();
	});
});

describe("runAnswerFrom", () => {
	it("keeps the run, its cards' columns and what waits", () => {
		const answer = runAnswerFrom({
			run: { ...serverRun, startedBy: "u-1" },
			cards: [
				{ id: "001-a", title: "Login", column: "in_progress", running: true },
				{ id: "002-b", title: "", column: "nowhere", running: "yes" },
				{ id: "003-c", title: "Cart", column: null, running: false },
				{ id: "a b", title: "x" },
				null,
			],
			blocked: ["003-c", "a/b"],
			ended: null,
			ignored: false,
		});
		expect(answer?.cards).toEqual([
			{ id: "001-a", title: "Login", column: "in_progress", running: true },
			{ id: "002-b", title: "002-b", column: null, running: false },
			{ id: "003-c", title: "Cart", column: null, running: false },
		]);
		expect(answer?.blocked).toEqual(["003-c"]);
		expect(answer?.run).not.toHaveProperty("startedBy");
	});

	it("says how the last run ended when none goes on", () => {
		expect(runAnswerFrom({ run: null, ended: "done", ignored: false, cards: [{ id: "001-a" }] })).toEqual({
			run: null,
			cards: [],
			blocked: [],
			ended: "done",
			ignored: false,
		});
		expect(runAnswerFrom({ ended: "exploded", ignored: true })).toEqual({
			run: null,
			cards: [],
			blocked: [],
			ended: null,
			ignored: true,
		});
	});

	it("is null for an answer that is not one, or a run that is not coherent", () => {
		expect(runAnswerFrom(undefined)).toBeNull();
		expect(runAnswerFrom({ run: { waves: [] } })).toBeNull();
	});
});

describe("historyFrom", () => {
	it("keeps the server's counts and its measured median", () => {
		expect(historyFrom(serverHistory)).toEqual({
			ignored: false,
			summary: {
				days: 14,
				runs: 3,
				stopped: 1,
				conflictsAvoided: 4,
				riskAvoided: 9.5,
				started: 7,
				lastFinishedAt: "2026-11-21T09:00:00+00:00",
			},
			conflicts: { ignored: false, resolved: 2, medianSeconds: 900, open: 1 },
		});
	});

	it("bounds what it does not trust and says when the conflict times are missing", () => {
		const history = historyFrom({ ignored: true, summary: { days: 1e6, lastFinishedAt: "" } });
		expect(history).toEqual({
			ignored: true,
			summary: {
				days: 366,
				runs: 0,
				stopped: 0,
				conflictsAvoided: 0,
				riskAvoided: 0,
				started: 0,
				lastFinishedAt: null,
			},
			conflicts: { ignored: true, resolved: 0, medianSeconds: null, open: 0 },
		});
		expect(historyFrom({ summary: {}, conflicts: { medianSeconds: -1 } })?.conflicts.medianSeconds).toBeNull();
		expect(historyFrom({ summary: {}, conflicts: { medianSeconds: "9" } })?.summary.days).toBe(1);
	});

	it("is null without a summary", () => {
		expect(historyFrom(null)).toBeNull();
		expect(historyFrom({ summary: [] })).toBeNull();
	});
});

describe("the requests", () => {
	it("reads each route of the project by id, as the person signed in", async () => {
		answered(serverPlan);
		expect((await fetchServerWavePlan(shop)).data?.waves).toHaveLength(2);
		answered({ run: serverRun, cards: [], blocked: [], ended: null, ignored: false });
		expect((await fetchServerWaveRun(shop)).data?.run?.advanceWhen).toBe("review");
		answered(serverHistory);
		expect((await fetchServerWaveHistory(shop)).data?.summary.runs).toBe(3);
		expect(mocks.authedFetch.mock.calls).toEqual([
			["/api/features/execution-waves/plan?project_id=p-1", "GET", undefined],
			["/api/features/execution-waves/run?project_id=p-1", "GET", undefined],
			["/api/features/execution-waves/history?project_id=p-1", "GET", undefined],
		]);
	});

	it("starts, steps and stops the run, sending only the advance rule", async () => {
		answered({ run: serverRun, ended: null, ignored: false });
		expect((await startServerWaveRun(shop, "merged")).success).toBe(true);
		answered({ run: serverRun, ended: null, ignored: false });
		expect((await stepServerWaveRun(shop)).success).toBe(true);
		answered({ run: null, ended: "stopped", ignored: false });
		expect((await stopServerWaveRun(shop)).data?.ended).toBe("stopped");
		expect(mocks.authedFetch.mock.calls).toEqual([
			["/api/features/execution-waves/run?project_id=p-1", "POST", { advanceWhen: "merged" }],
			["/api/features/execution-waves/run/step?project_id=p-1", "POST", undefined],
			["/api/features/execution-waves/run?project_id=p-1", "DELETE", undefined],
		]);
	});

	it("refuses an advance rule outside the closed list before any request", async () => {
		expect(await startServerWaveRun(shop, "whenever")).toEqual({
			success: false,
			error: "advanceWhen must be merged or review",
		});
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("passes the server's refusal on, and refuses an answer it cannot rebuild", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Permission denied" });
		expect(await stepServerWaveRun(shop)).toEqual({ success: false, error: "Permission denied" });
		answered("<html>");
		expect(await fetchServerWavePlan(shop)).toEqual({ success: false, error: "Unexpected answer from the server" });
	});
});

describe("the channels", () => {
	it("answer only for a project the server listed", async () => {
		registerServerConflictWavesHandlers();
		mocks.getServerProject.mockImplementation((id: unknown) =>
			id === "p-1" ? shop : id === "local" ? { id: "local", path: "/x" } : undefined,
		);
		for (const channel of [
			IPC_CHANNELS.CONFLICT_WAVES_SERVER_PLAN,
			IPC_CHANNELS.CONFLICT_WAVES_SERVER_RUN,
			IPC_CHANNELS.CONFLICT_WAVES_SERVER_START,
			IPC_CHANNELS.CONFLICT_WAVES_SERVER_STEP,
			IPC_CHANNELS.CONFLICT_WAVES_SERVER_STOP,
			IPC_CHANNELS.CONFLICT_WAVES_SERVER_HISTORY,
		]) {
			const handler = mocks.handlers.get(channel) as (...args: unknown[]) => Promise<unknown>;
			expect(await handler({}, "/etc/passwd")).toEqual({ success: false, error: "Not a project of the server" });
			expect(await handler({}, "local")).toEqual({ success: false, error: "Not a project of the server" });
		}
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("route each channel to its request", async () => {
		registerServerConflictWavesHandlers();
		mocks.getServerProject.mockReturnValue(shop);
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { ...serverPlan, ...serverHistory, run: null } });
		const call = (channel: string, ...args: unknown[]) =>
			(mocks.handlers.get(channel) as (...a: unknown[]) => Promise<{ success: boolean }>)({}, "p-1", ...args);
		expect((await call(IPC_CHANNELS.CONFLICT_WAVES_SERVER_PLAN)).success).toBe(true);
		expect((await call(IPC_CHANNELS.CONFLICT_WAVES_SERVER_RUN)).success).toBe(true);
		expect((await call(IPC_CHANNELS.CONFLICT_WAVES_SERVER_START, "review")).success).toBe(true);
		expect((await call(IPC_CHANNELS.CONFLICT_WAVES_SERVER_STEP)).success).toBe(true);
		expect((await call(IPC_CHANNELS.CONFLICT_WAVES_SERVER_STOP)).success).toBe(true);
		expect((await call(IPC_CHANNELS.CONFLICT_WAVES_SERVER_HISTORY)).success).toBe(true);
		expect(mocks.authedFetch.mock.calls.map(([route, method]) => `${method} ${route}`)).toEqual([
			"GET /api/features/execution-waves/plan?project_id=p-1",
			"GET /api/features/execution-waves/run?project_id=p-1",
			"POST /api/features/execution-waves/run?project_id=p-1",
			"POST /api/features/execution-waves/run/step?project_id=p-1",
			"DELETE /api/features/execution-waves/run?project_id=p-1",
			"GET /api/features/execution-waves/history?project_id=p-1",
		]);
	});
});
