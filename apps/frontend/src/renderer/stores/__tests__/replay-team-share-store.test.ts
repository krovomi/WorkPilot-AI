/**
 * Team links to a replay (#347): the store keeps each project's links and
 * the link made last (its token is shown only then), says what went wrong as
 * an i18n key, and ends an opened link like an import.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayTeamShare } from "../../../shared/types/replay-share";
import { useAgentReplayStore } from "../agent-replay-store";
import { useReplayShareStore } from "../replay-share-store";
import { useReplayTeamShareStore } from "../replay-team-share-store";

vi.mock("i18next", () => ({ default: { t: (key: string) => key, language: "en" } }));

const api = {
	listReplayTeamShares: vi.fn(),
	shareReplayToTeam: vi.fn(),
	revokeReplayTeamShare: vi.fn(),
	openReplayTeamShare: vi.fn(),
};

const share = (id: string, state: ReplayTeamShare["state"] = "active"): ReplayTeamShare => ({
	id,
	title: "coder",
	steps: 2,
	createdBy: "Ada",
	createdAt: "2026-11-21T10:00:00Z",
	expiresAt: "2026-11-28T10:00:00Z",
	state,
	openCount: 0,
	canRevoke: true,
});

const request = {
	projectId: "p1",
	ttlDays: 7,
	stripReasoning: false,
	stripTokens: false,
	includeFileContents: false,
};

const fetchSessions = vi.fn();

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	fetchSessions.mockReset();
	vi.stubGlobal("window", { electronAPI: api });
	useReplayTeamShareStore.setState({
		shares: {},
		loading: false,
		sharing: false,
		opening: false,
		lastLink: null,
		error: null,
	});
	useReplayShareStore.setState({ notice: null });
	useAgentReplayStore.setState({ fetchSessions } as never);
});

describe("loadShares", () => {
	it("keeps each project's links", async () => {
		api.listReplayTeamShares.mockResolvedValueOnce({ success: true, shares: [share("a")] });
		await useReplayTeamShareStore.getState().loadShares("p1");
		const state = useReplayTeamShareStore.getState();
		expect(state.shares.p1.map((s) => s.id)).toEqual(["a"]);
		expect(state.loading).toBe(false);
	});

	it("says why the list failed", async () => {
		api.listReplayTeamShares.mockResolvedValueOnce({ success: false, error: "bad_share" });
		await useReplayTeamShareStore.getState().loadShares("p1");
		expect(useReplayTeamShareStore.getState().error).toEqual({
			tone: "error",
			key: "replay:share.errors.bad_share",
		});
	});
});

describe("share", () => {
	it("keeps the new link and puts its share first", async () => {
		useReplayTeamShareStore.setState({ shares: { p1: [share("old")] } });
		api.shareReplayToTeam.mockResolvedValueOnce({
			success: true,
			link: "workpilot-replay://x/p1/new#t",
			share: share("new"),
		});
		expect(await useReplayTeamShareStore.getState().share("s1", request)).toBe(true);
		const state = useReplayTeamShareStore.getState();
		expect(api.shareReplayToTeam).toHaveBeenCalledWith("s1", request);
		expect(state.lastLink).toEqual({ projectId: "p1", link: "workpilot-replay://x/p1/new#t" });
		expect(state.shares.p1.map((s) => s.id)).toEqual(["new", "old"]);
		expect(state.sharing).toBe(false);
	});

	it("starts a project's list with its first link", async () => {
		api.shareReplayToTeam.mockResolvedValueOnce({
			success: true,
			link: "l",
			share: share("first"),
		});
		await useReplayTeamShareStore.getState().share("s1", request);
		expect(useReplayTeamShareStore.getState().shares.p1).toHaveLength(1);
	});

	it("says why nothing was shared, with the server's own word when it has none", async () => {
		api.shareReplayToTeam.mockResolvedValueOnce({
			success: false,
			error: '{"detail": "too_many_shares"}',
		});
		expect(await useReplayTeamShareStore.getState().share("s1", request)).toBe(false);
		expect(useReplayTeamShareStore.getState().error?.key).toBe(
			"replay:share.errors.too_many_shares",
		);
		api.shareReplayToTeam.mockResolvedValueOnce({ success: false, error: "HTTP 502" });
		await useReplayTeamShareStore.getState().share("s1", request);
		expect(useReplayTeamShareStore.getState().error).toEqual({
			tone: "error",
			key: "replay:share.errors.generic",
			values: { error: "HTTP 502" },
		});
	});
});

describe("revoke", () => {
	it("lists the project again once revoked", async () => {
		api.revokeReplayTeamShare.mockResolvedValueOnce({ success: true });
		api.listReplayTeamShares.mockResolvedValueOnce({
			success: true,
			shares: [share("a", "revoked")],
		});
		await useReplayTeamShareStore.getState().revoke("p1", "a");
		expect(api.revokeReplayTeamShare).toHaveBeenCalledWith("p1", "a");
		expect(useReplayTeamShareStore.getState().shares.p1[0].state).toBe("revoked");
	});

	it("says why it was not revoked", async () => {
		api.revokeReplayTeamShare.mockResolvedValueOnce({ success: false, error: "share_not_found" });
		await useReplayTeamShareStore.getState().revoke("p1", "a");
		expect(useReplayTeamShareStore.getState().error?.key).toBe(
			"replay:share.errors.share_not_found",
		);
		expect(api.listReplayTeamShares).not.toHaveBeenCalled();
	});
});

describe("openLink", () => {
	it("imports the session, says so on the replay view and lists sessions again", async () => {
		api.openReplayTeamShare.mockResolvedValueOnce({
			success: true,
			session: { session_id: "n", agent_name: "coder" },
		});
		expect(await useReplayTeamShareStore.getState().openLink("  link  ")).toBe(true);
		expect(api.openReplayTeamShare).toHaveBeenCalledWith("link");
		expect(useReplayShareStore.getState().notice).toEqual({
			tone: "ok",
			key: "replay:share.imported",
			values: { name: "coder" },
		});
		expect(fetchSessions).toHaveBeenCalled();
		expect(useReplayTeamShareStore.getState().opening).toBe(false);
	});

	it("says why the link did not open", async () => {
		api.openReplayTeamShare.mockResolvedValueOnce({ success: false, error: "share_expired" });
		expect(await useReplayTeamShareStore.getState().openLink("l")).toBe(false);
		expect(useReplayShareStore.getState().notice?.key).toBe(
			"replay:share.errors.share_expired",
		);
		expect(fetchSessions).not.toHaveBeenCalled();
	});

	it("does nothing more for a canceled answer", async () => {
		api.openReplayTeamShare.mockResolvedValueOnce({ success: true, canceled: true });
		expect(await useReplayTeamShareStore.getState().openLink("l")).toBe(false);
		expect(useReplayShareStore.getState().notice).toBeNull();
	});
});

it("clear forgets the link and the error", () => {
	useReplayTeamShareStore.setState({
		lastLink: { projectId: "p", link: "l" },
		error: { tone: "error", key: "k" },
	});
	useReplayTeamShareStore.getState().clear();
	expect(useReplayTeamShareStore.getState()).toMatchObject({ lastLink: null, error: null });
});
