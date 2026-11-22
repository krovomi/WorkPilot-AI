/**
 * How replays are shared (#347): main counts an export on the local backend
 * by its kind, reads this machine's report from it, and a server project's
 * aggregates from that server, only for a project the app listed. Each
 * answer is checked again; nothing is sent anywhere else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { ReplayExportKind } from "../../shared/types/replay-share";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	getServerProject: vi.fn(),
	isServerMode: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("../server-connection", () => ({
	authedFetch: mocks.authedFetch,
	isServerMode: mocks.isServerMode,
}));
vi.mock("../server-projects", () => ({ getServerProject: mocks.getServerProject }));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));

import { registerReplayUsageHandlers } from "../ipc-handlers/replay-usage-handlers";
import { recordReplayExport, toReplayUsage, toTeamUsage } from "../replay-usage";

const PROJECT = "3f6c2a10-0000-4000-8000-000000000001";
const fetchMock = vi.fn();

const localReport = (extra: object = {}) => ({
	success: true,
	weeks: [
		{
			start: 1_800_000_000,
			end: 1_800_604_800,
			total: 3,
			by_kind: { wpreplay: 1, html: 1, video: 1, team_link: -2, other: 9 },
		},
	],
	exports: 3,
	exports_per_week: 0.38,
	sessions: { total: 4, annotated: 2, discussed: 1, summarized: 1, imported: "x" },
	annotated_ratio: 0.5,
	...extra,
});

const teamReport = (extra: object = {}) => ({
	window_days: 28,
	weeks: [
		{
			start: "2026-10-24T10:00:00+00:00",
			end: "2026-10-31T10:00:00+00:00",
			created: 2,
			opened: 1,
		},
	],
	links: 2,
	opened_links: 1,
	open_rate: 0.5,
	opens: 3,
	active: 2,
	annotated: 1,
	annotated_ratio: 2,
	sharers: 1,
	...extra,
});

const backend = (body: object, status = 200) =>
	fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

const call = (channel: string, ...args: unknown[]) => {
	const handler = mocks.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<Record<string, unknown>>;
};

beforeEach(() => {
	for (const mock of [mocks.authedFetch, mocks.getServerProject, fetchMock]) {
		mock.mockReset();
	}
	mocks.isServerMode.mockReturnValue(true);
	mocks.getServerProject.mockImplementation((id: unknown) =>
		id === PROJECT ? { id: PROJECT } : undefined,
	);
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VITE_BACKEND_URL", "");
	vi.stubEnv("BACKEND_URL", "");
	mocks.handlers.clear();
	registerReplayUsageHandlers();
	return () => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	};
});

describe("counting an export", () => {
	it("sends its kind, and only a known kind", async () => {
		backend({ success: true });
		await recordReplayExport("html");
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("http://127.0.0.1:9000/replay/usage/exports");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ kind: "html" });
		await recordReplayExport("elsewhere" as ReplayExportKind);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("never throws when the backend does not answer", async () => {
		fetchMock.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "AbortError" }));
		await expect(recordReplayExport("video")).resolves.toBeUndefined();
	});
});

describe("REPLAY_GET_USAGE", () => {
	it("answers this machine's report, checked again", async () => {
		backend(localReport());
		const result = await call(IPC_CHANNELS.REPLAY_GET_USAGE);
		expect(result).toEqual({
			success: true,
			usage: {
				weeks: [
					{
						start: new Date(1_800_000_000_000).toISOString(),
						end: new Date(1_800_604_800_000).toISOString(),
						total: 3,
						byKind: { wpreplay: 1, html: 1, video: 1, team_link: 0 },
					},
				],
				exports: 3,
				exportsPerWeek: 0.38,
				sessions: { total: 4, annotated: 2, discussed: 1, summarized: 1, imported: 0 },
				annotatedRatio: 0.5,
			},
		});
		expect(String(fetchMock.mock.calls[0][0])).toContain("/replay/usage");
	});

	it("passes on the backend's failure and refuses a malformed report", async () => {
		backend({ detail: "down" }, 500);
		expect((await call(IPC_CHANNELS.REPLAY_GET_USAGE)).success).toBe(false);
		backend(localReport({ sessions: null }));
		expect(await call(IPC_CHANNELS.REPLAY_GET_USAGE)).toEqual({
			success: false,
			error: "bad_usage",
		});
	});

	it.each([
		["not a record", "x"],
		["weeks that are not a list", localReport({ weeks: {} })],
		["a week that is not a record", localReport({ weeks: [1] })],
		["a week without its dates", localReport({ weeks: [{ start: "nope", end: 1 }] })],
		["a date too large", localReport({ weeks: [{ start: 1e20, end: 1 }] })],
	])("refuses %s", (_name, raw) => {
		expect(toReplayUsage(raw)).toBeNull();
	});

	it("reads what is not a figure as none", () => {
		const usage = toReplayUsage(
			localReport({
				exports_per_week: Number.NaN,
				annotated_ratio: "half",
				weeks: [{ start: 1, end: 2, total: 1.5 }],
			}),
		);
		expect(usage?.exportsPerWeek).toBe(0);
		expect(usage?.annotatedRatio).toBeNull();
		expect(usage?.weeks[0].total).toBe(0);
		expect(usage?.weeks[0].byKind.html).toBe(0);
	});
});

describe("REPLAY_GET_TEAM_USAGE", () => {
	it("asks the server for a listed project's aggregates, checked again", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: teamReport() });
		const result = await call(IPC_CHANNELS.REPLAY_GET_TEAM_USAGE, PROJECT);
		expect(result).toEqual({
			success: true,
			usage: {
				windowDays: 28,
				weeks: [
					{
						start: "2026-10-24T10:00:00+00:00",
						end: "2026-10-31T10:00:00+00:00",
						created: 2,
						opened: 1,
					},
				],
				links: 2,
				openedLinks: 1,
				openRate: 0.5,
				opens: 3,
				active: 2,
				annotated: 1,
				annotatedRatio: null,
				sharers: 1,
			},
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			`/api/features/replay-shares/usage?project_id=${PROJECT}`,
			"GET",
		);
	});

	it("refuses a project it did not list, or outside server mode", async () => {
		expect(await call(IPC_CHANNELS.REPLAY_GET_TEAM_USAGE, "../x")).toEqual({
			success: false,
			error: "not_a_server_project",
		});
		mocks.isServerMode.mockReturnValueOnce(false);
		expect((await call(IPC_CHANNELS.REPLAY_GET_TEAM_USAGE, PROJECT)).error).toBe(
			"not_a_server_project",
		);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("passes on the server's failure and refuses a malformed answer", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Missing permission: lab.read" });
		expect(await call(IPC_CHANNELS.REPLAY_GET_TEAM_USAGE, PROJECT)).toEqual({
			success: false,
			error: "Missing permission: lab.read",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: teamReport({ weeks: "x" }) });
		expect((await call(IPC_CHANNELS.REPLAY_GET_TEAM_USAGE, PROJECT)).error).toBe("bad_usage");
		expect(toTeamUsage(null)).toBeNull();
		expect(toTeamUsage(teamReport({ weeks: [{ start: "x".repeat(80), end: "y" }] }))).toBeNull();
	});
});
