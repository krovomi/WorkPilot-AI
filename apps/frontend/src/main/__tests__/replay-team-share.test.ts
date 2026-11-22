/**
 * Team links to a replay (#347): main builds the masked bundle on the local
 * backend, leaves it with a server project the app listed, and answers a
 * link; a pasted link opens only from the server the app is signed in to, for
 * a project it listed, with its token in the request body. What the server
 * answers is checked again, and a bundle comes back through the local import.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	getServerProject: vi.fn(),
	getServerUrl: vi.fn(),
	isServerMode: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("../server-connection", () => ({
	authedFetch: mocks.authedFetch,
	getServerUrl: mocks.getServerUrl,
	isServerMode: mocks.isServerMode,
}));
vi.mock("../server-projects", () => ({ getServerProject: mocks.getServerProject }));
vi.mock("../electron-utils", () => ({ showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));

import { registerReplayTeamShareHandlers } from "../ipc-handlers/replay-team-share-handlers";
import {
	buildShareLink,
	listMyTeamShares,
	MAX_SHARED_BYTES,
	openTeamShare,
	parseShareLink,
	shareToTeam,
	teamShareBody,
	toMyTeamShare,
	toTeamShare,
} from "../replay-team-share";

const SERVER = "https://wp.example.com:8443";
const PROJECT = "3f6c2a10-0000-4000-8000-000000000001";
const SHARE = "9b1d7c4e-0000-4000-8000-000000000002";
const TOKEN = "A".repeat(43);
const LINK = `workpilot-replay://wp.example.com:8443/${PROJECT}/${SHARE}#${TOKEN}`;
const GZIP = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(10)]);
const fetchMock = vi.fn();

const row = (extra: object = {}) => ({
	id: SHARE,
	title: "coder: Fix the bug",
	steps: 4,
	created_by: "Ada",
	created_at: "2026-11-21T10:00:00+00:00",
	expires_at: "2026-11-28T10:00:00+00:00",
	state: "active",
	open_count: 2,
	last_opened_at: "2026-11-21T11:00:00+00:00",
	can_revoke: true,
	...extra,
});

const backend = (body: object, status = 200) =>
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify(status === 200 ? { success: true, ...body } : body), { status }),
	);

const request = { projectId: PROJECT, ttlDays: 7, stripTokens: true };

const call = (channel: string, ...args: unknown[]) => {
	const handler = mocks.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<Record<string, unknown>>;
};

beforeEach(() => {
	for (const mock of [mocks.authedFetch, mocks.getServerProject, fetchMock]) {
		mock.mockReset();
	}
	mocks.getServerUrl.mockReturnValue(SERVER);
	mocks.isServerMode.mockReturnValue(true);
	mocks.getServerProject.mockImplementation((id: unknown) =>
		id === PROJECT ? { id: PROJECT } : undefined,
	);
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VITE_BACKEND_URL", "");
	vi.stubEnv("BACKEND_URL", "");
	mocks.handlers.clear();
	registerReplayTeamShareHandlers();
	return () => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	};
});

describe("the link", () => {
	it("names the server's host, the project, the share and the token", () => {
		expect(buildShareLink(SERVER, PROJECT, SHARE, TOKEN)).toBe(LINK);
		expect(parseShareLink(`  ${LINK} `)).toEqual({
			host: "wp.example.com:8443",
			projectId: PROJECT,
			shareId: SHARE,
			token: TOKEN,
		});
	});

	it("is not built from a bad server URL, share id or token", () => {
		expect(buildShareLink("not a url", PROJECT, SHARE, TOKEN)).toBeNull();
		expect(buildShareLink("file:///x", PROJECT, SHARE, TOKEN)).toBeNull();
		expect(buildShareLink(SERVER, PROJECT, "../x", TOKEN)).toBeNull();
		expect(buildShareLink(SERVER, PROJECT, SHARE, "short")).toBeNull();
	});

	it.each([
		42,
		"x".repeat(600),
		"not a url",
		`https://wp.example.com/${PROJECT}/${SHARE}#${TOKEN}`,
		`workpilot-replay:///${PROJECT}/${SHARE}#${TOKEN}`,
		`workpilot-replay://wp.example.com/${PROJECT}/${SHARE}?token=${TOKEN}`,
		`workpilot-replay://wp.example.com/${PROJECT}/${SHARE}`,
		`workpilot-replay://wp.example.com/${PROJECT}/${SHARE}/more#${TOKEN}`,
		`workpilot-replay://wp.example.com/-bad/${SHARE}#${TOKEN}`,
		`workpilot-replay://wp.example.com/${PROJECT}/not-a-share#${TOKEN}`,
	])("refuses %s", (raw) => {
		expect(parseShareLink(raw)).toBeNull();
	});
});

describe("what the renderer and the server send", () => {
	it("keeps a project id, a lifetime from the list and booleans", () => {
		expect(teamShareBody(request)).toEqual({
			projectId: PROJECT,
			ttlDays: 7,
			stripReasoning: false,
			stripTokens: true,
			includeFileContents: false,
		});
	});

	it.each([
		null,
		[],
		{ ...request, projectId: "../x" },
		{ ...request, projectId: 3 },
		{ ...request, ttlDays: 3 },
		{ ...request, ttlDays: "7" },
		{ ...request, includeFileContents: "yes" },
	])("refuses the request %j", (raw) => {
		expect(teamShareBody(raw)).toBeNull();
	});

	it("checks a share again, and drops a malformed one", () => {
		expect(toTeamShare(row())).toEqual({
			id: SHARE,
			title: "coder: Fix the bug",
			steps: 4,
			createdBy: "Ada",
			createdAt: "2026-11-21T10:00:00+00:00",
			expiresAt: "2026-11-28T10:00:00+00:00",
			state: "active",
			openCount: 2,
			lastOpenedAt: "2026-11-21T11:00:00+00:00",
			canRevoke: true,
		});
		expect(
			toTeamShare(
				row({ title: "", created_by: 3, steps: -1, open_count: 1.5, last_opened_at: null, can_revoke: "yes" }),
			),
		).toMatchObject({ title: "session", createdBy: "", steps: 0, openCount: 0, canRevoke: false });
		expect(toTeamShare(row({ last_opened_at: null }))?.lastOpenedAt).toBeUndefined();
		for (const bad of [null, row({ id: "x" }), row({ state: "open" }), row({ expires_at: "soon" })]) {
			expect(toTeamShare(bad)).toBeNull();
		}
	});
});

describe("REPLAY_SHARE_TO_TEAM", () => {
	it("builds the bundle here, leaves it with the project and answers the link", async () => {
		backend({ content_base64: GZIP.toString("base64") });
		mocks.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { share: row(), token: TOKEN },
		});
		const result = await call(IPC_CHANNELS.REPLAY_SHARE_TO_TEAM, "s1", request);
		expect(result).toMatchObject({ success: true, link: LINK, share: { id: SHARE } });
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/replay/sessions/s1/export");
		expect(JSON.parse(String(init.body))).toEqual({
			format: "wpreplay",
			strip_reasoning: false,
			strip_tokens: true,
			include_file_contents: false,
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			`/api/features/replay-shares?project_id=${PROJECT}`,
			"POST",
			{ content_base64: GZIP.toString("base64"), ttl_days: 7 },
		);
		// The link is counted on this machine, by its kind only.
		const [counted, counting] = fetchMock.mock.calls[1];
		expect(String(counted)).toContain("/replay/usage/exports");
		expect(JSON.parse(String(counting.body))).toEqual({ kind: "team_link" });
	});

	it("refuses before asking anything", async () => {
		expect(await shareToTeam("a/b", request)).toEqual({
			success: false,
			error: "Invalid session id",
		});
		expect(await shareToTeam("s1", { ...request, ttlDays: 9 })).toEqual({
			success: false,
			error: "Invalid share options",
		});
		const other = { ...request, projectId: "other-project" };
		expect(await shareToTeam("s1", other)).toEqual({
			success: false,
			error: "not_a_server_project",
		});
		mocks.isServerMode.mockReturnValue(false);
		expect((await shareToTeam("s1", request)).success).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("passes on the backend's failure, and refuses what is not a bundle", async () => {
		backend({ detail: "Replay session not found" }, 404);
		expect((await shareToTeam("s1", request)).success).toBe(false);
		backend({ content_base64: Buffer.from("<html>").toString("base64") });
		expect(await shareToTeam("s1", request)).toEqual({
			success: false,
			error: "bad_export",
		});
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("does not send a bundle over the server's bound", async () => {
		const big = Buffer.concat([GZIP, Buffer.alloc(MAX_SHARED_BYTES)]);
		backend({ content_base64: big.toString("base64") });
		expect(await shareToTeam("s1", request)).toEqual({
			success: false,
			error: "too_large_to_share",
		});
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("passes on the server's refusal, and refuses an answer without a link", async () => {
		backend({ content_base64: GZIP.toString("base64") });
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "too_many_shares" });
		expect(await shareToTeam("s1", request)).toEqual({
			success: false,
			error: "too_many_shares",
		});
		for (const data of [null, { share: row() }, { share: row({ id: "x" }), token: TOKEN }]) {
			backend({ content_base64: GZIP.toString("base64") });
			mocks.authedFetch.mockResolvedValueOnce({ ok: true, data });
			expect(await shareToTeam("s1", request)).toEqual({
				success: false,
				error: "bad_share",
			});
		}
	});
});

describe("REPLAY_LIST_TEAM_SHARES and REPLAY_REVOKE_TEAM_SHARE", () => {
	it("lists a listed project's shares, checked again", async () => {
		mocks.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { shares: [row(), row({ id: "bad" })] },
		});
		const result = await call(IPC_CHANNELS.REPLAY_LIST_TEAM_SHARES, PROJECT);
		expect(result).toMatchObject({ success: true, shares: [{ id: SHARE }] });
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			`/api/features/replay-shares?project_id=${PROJECT}`,
			"GET",
		);
	});

	it("refuses another project, and passes on a failure or a bad answer", async () => {
		expect(await call(IPC_CHANNELS.REPLAY_LIST_TEAM_SHARES, "nope")).toEqual({
			success: false,
			error: "not_a_server_project",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "HTTP 500" });
		expect(await call(IPC_CHANNELS.REPLAY_LIST_TEAM_SHARES, PROJECT)).toEqual({
			success: false,
			error: "HTTP 500",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: [] });
		expect(await call(IPC_CHANNELS.REPLAY_LIST_TEAM_SHARES, PROJECT)).toEqual({
			success: false,
			error: "bad_share",
		});
	});

	it("revokes a share by its id, on a listed project", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { revoked: true } });
		expect(await call(IPC_CHANNELS.REPLAY_REVOKE_TEAM_SHARE, PROJECT, SHARE)).toEqual({
			success: true,
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			`/api/features/replay-shares/${SHARE}?project_id=${PROJECT}`,
			"DELETE",
		);
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Only its author" });
		expect(await call(IPC_CHANNELS.REPLAY_REVOKE_TEAM_SHARE, PROJECT, SHARE)).toEqual({
			success: false,
			error: "Only its author",
		});
		expect((await call(IPC_CHANNELS.REPLAY_REVOKE_TEAM_SHARE, "nope", SHARE)).error).toBe(
			"not_a_server_project",
		);
		expect((await call(IPC_CHANNELS.REPLAY_REVOKE_TEAM_SHARE, PROJECT, "../x")).error).toBe(
			"Invalid share id",
		);
		expect(mocks.authedFetch).toHaveBeenCalledTimes(2);
	});
});

describe("REPLAY_LIST_MY_TEAM_SHARES", () => {
	const mine = (extra: object = {}) =>
		row({ project_id: PROJECT, project_name: "Shop", ...extra });

	it("lists the person's links on every project, checked again", async () => {
		mocks.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: {
				shares: [
					mine(),
					mine({ project_id: "../etc" }),
					mine({ project_name: "" }),
					row(),
					mine({ id: "bad" }),
				],
			},
		});
		const result = await call(IPC_CHANNELS.REPLAY_LIST_MY_TEAM_SHARES);
		expect(result).toMatchObject({
			success: true,
			shares: [
				{ id: SHARE, projectId: PROJECT, projectName: "Shop", canRevoke: true },
				{ id: SHARE, projectId: PROJECT, projectName: PROJECT },
			],
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith("/api/features/replay-shares/mine", "GET");
		expect(toMyTeamShare("not a share")).toBeNull();
	});

	it("needs a signed-in server, and passes on a failure or a bad answer", async () => {
		mocks.isServerMode.mockReturnValueOnce(false);
		expect(await listMyTeamShares()).toEqual({ success: false, error: "not_signed_in" });
		mocks.getServerUrl.mockReturnValueOnce(null);
		expect(await listMyTeamShares()).toEqual({ success: false, error: "not_signed_in" });
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "HTTP 403" });
		expect(await listMyTeamShares()).toEqual({ success: false, error: "HTTP 403" });
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { shares: "x" } });
		expect(await listMyTeamShares()).toEqual({ success: false, error: "bad_share" });
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: null });
		expect(await listMyTeamShares()).toEqual({ success: false, error: "bad_share" });
	});
});

describe("REPLAY_OPEN_TEAM_SHARE", () => {
	it("opens the link with its token in the body and imports the bundle here", async () => {
		mocks.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { title: "coder", content_base64: GZIP.toString("base64") },
		});
		backend({ success: true, session: { session_id: "new", agent_name: "coder" } });
		const result = await call(IPC_CHANNELS.REPLAY_OPEN_TEAM_SHARE, LINK);
		expect(result).toMatchObject({ success: true, session: { session_id: "new" } });
		const [route, method, body] = mocks.authedFetch.mock.calls[0];
		expect(route).toBe(`/api/features/replay-shares/${SHARE}/open?project_id=${PROJECT}`);
		expect(route).not.toContain(TOKEN);
		expect([method, body]).toEqual(["POST", { token: TOKEN }]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/replay/import");
		expect(JSON.parse(String(init.body))).toEqual({
			content_base64: GZIP.toString("base64"),
		});
	});

	it.each([
		["not_a_link", "nonsense", () => undefined],
		["not_signed_in", LINK, () => mocks.isServerMode.mockReturnValue(false)],
		["not_signed_in", LINK, () => mocks.getServerUrl.mockReturnValue(null)],
		["other_server", LINK, () => mocks.getServerUrl.mockReturnValue("https://evil.example")],
		["other_server", LINK, () => mocks.getServerUrl.mockReturnValue("::bad::")],
		["not_a_server_project", LINK, () => mocks.getServerProject.mockReturnValue(undefined)],
	])("answers %s before asking the server", async (error, link, arrange) => {
		arrange();
		expect(await openTeamShare(link)).toEqual({ success: false, error });
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("passes on the server's refusal, and imports nothing that is not a bundle", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "share_expired" });
		expect(await openTeamShare(LINK)).toEqual({ success: false, error: "share_expired" });
		for (const data of [null, { content_base64: "<b>" }]) {
			mocks.authedFetch.mockResolvedValueOnce({ ok: true, data });
			expect(await openTeamShare(LINK)).toEqual({ success: false, error: "bad_share" });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
