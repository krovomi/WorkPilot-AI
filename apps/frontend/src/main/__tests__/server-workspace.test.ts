/**
 * The dashboard, analytics, costs and session history of a server project are
 * read from the server, by project id: nothing on this computer, no path
 * sent. What the server answers is checked again before a view draws it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { Project } from "../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	getServerProject: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../server-projects", () => ({ getServerProject: mocks.getServerProject }));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));

import { registerServerWorkspaceHandlers } from "../ipc-handlers/server-workspace-handlers";
import {
	fetchServerCostSummary,
	fetchServerDashboard,
	fetchServerSessions,
	toSession,
} from "../server-workspace";

const project = {
	id: "p 1",
	path: "/nowhere/mirror",
	remote: { repoUrl: "https://github.com/acme/shop.git", defaultBranch: "main", role: "viewer" },
} as unknown as Project;

function answered(data: unknown) {
	mocks.authedFetch.mockResolvedValueOnce({ ok: true, data });
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.getServerProject.mockReset();
});

describe("a server project's workspace", () => {
	it("reads the costs from the server, by project id", async () => {
		answered({
			summary: {
				total_cost: 1.5,
				cost_by_provider: { anthropic: 1.5 },
				cost_by_model: { "anthropic/sonnet": 1.5 },
				total_tokens: 300,
				tokens_input: 200,
				tokens_output: 100,
				period_days: 3,
				daily_avg: 0.5,
				trend_pct: -20,
			},
		});
		const result = await fetchServerCostSummary(project);
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/workspace/costs?project_id=p%201",
			"GET",
		);
		expect(result).toEqual({
			success: true,
			data: {
				total_cost: 1.5,
				cost_by_provider: { anthropic: 1.5 },
				cost_by_model: { "anthropic/sonnet": 1.5 },
				total_tokens: 300,
				tokens_input: 200,
				tokens_output: 100,
				period_days: 3,
				daily_avg: 0.5,
				trend_pct: -20,
			},
		});
	});

	it("keeps only numbers it can draw", async () => {
		answered({
			snapshot: {
				tasks_by_status: { completed: 2, pending: "x", in_progress: -1 },
				qa_first_pass_rate: 400,
				total_cost: Number.NaN,
				cost_by_model: [1, 2],
				merge_auto_count: 1,
			},
		});
		const result = await fetchServerDashboard(project);
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			tasks_by_status: { completed: 2, pending: 0, in_progress: 0 },
			qa_first_pass_rate: 100,
			total_cost: 0,
			cost_by_model: {},
			merge_auto_count: 1,
			merge_manual_count: 0,
		});
	});

	it("lists the runs and jobs as sessions, and skips what is not one", async () => {
		answered({
			sessions: [
				{
					id: "r-1",
					kind: "run",
					spec: "001-login",
					phase: "build",
					status: "succeeded",
					started_by: "Ada",
					started_at: "2026-10-30T10:00:00+00:00",
					finished_at: "2026-10-30T10:30:00+00:00",
					duration_seconds: 1800,
					tokens: 1500,
					cost: 0.5,
					phases: [{ name: "coding", tokens: 1500, cost: 0.5 }, "bad"],
					error: null,
				},
				{
					id: "j-1",
					kind: "job",
					spec: null,
					phase: "roadmap",
					status: "cancelled",
					started_at: "2026-10-31T10:00:00+00:00",
					tokens: null,
				},
				{ id: "x", kind: "other", started_at: "2026-10-31T10:00:00+00:00" },
				{ id: "y", kind: "run", started_at: "not a date" },
			],
		});
		const result = await fetchServerSessions(project);
		expect(result.data).toEqual([
			{
				session_id: "r-1",
				kind: "run",
				status: "completed",
				started_at: "2026-10-30T10:00:00+00:00",
				ended_at: "2026-10-30T10:30:00+00:00",
				task_title: "001-login",
				task_id: "001-login",
				phase: "build",
				started_by: "Ada",
				duration_seconds: 1800,
				tokens_used: 1500,
				cost: 0.5,
				phases: [{ name: "coding", status: "completed", tokens: 1500 }],
			},
			{
				session_id: "j-1",
				kind: "job",
				status: "cancelled",
				started_at: "2026-10-31T10:00:00+00:00",
				task_title: "roadmap",
				phase: "roadmap",
			},
		]);
	});

	it("cuts an error and gives an unknown status no meaning", () => {
		const session = toSession({
			id: "r-2",
			kind: "run",
			status: "exploded",
			started_at: "2026-10-30T10:00:00Z",
			error: "e".repeat(10_000),
		});
		expect(session?.status).toBe("queued");
		expect(session?.error).toHaveLength(2_000);
	});

	it("passes a refusal of the server on as it is", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Project not found" });
		expect(await fetchServerSessions(project)).toEqual({
			success: false,
			error: "Project not found",
		});
		answered({ sessions: "nope" });
		expect((await fetchServerSessions(project)).success).toBe(false);
	});
});

describe("the workspace channels", () => {
	registerServerWorkspaceHandlers();

	it("answer only for a server project the app listed", async () => {
		mocks.getServerProject.mockReturnValue(undefined);
		for (const channel of [
			IPC_CHANNELS.SERVER_WORKSPACE_COSTS,
			IPC_CHANNELS.SERVER_WORKSPACE_DASHBOARD,
			IPC_CHANNELS.SERVER_WORKSPACE_SESSIONS,
		]) {
			const handler = mocks.handlers.get(channel);
			expect(await handler?.({}, "/home/me/project")).toEqual({
				success: false,
				error: "Not a project of the server",
			});
		}
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("read the server for one", async () => {
		mocks.getServerProject.mockReturnValue(project);
		answered({ sessions: [] });
		const handler = mocks.handlers.get(IPC_CHANNELS.SERVER_WORKSPACE_SESSIONS);
		expect(await handler?.({}, "p 1")).toEqual({ success: true, data: [] });
		expect(mocks.getServerProject).toHaveBeenCalledWith("p 1");
	});
});
