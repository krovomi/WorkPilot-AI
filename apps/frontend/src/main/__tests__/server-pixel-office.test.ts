/**
 * Pixel Office's team leaderboard (#350): main asks the server the app is
 * signed in to, for a project it listed, with a scope and a period from closed
 * lists; the answer is read again field by field. Saving one's consent sends
 * a boolean and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

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
vi.mock("../oneshot-llm", () => ({ runOneShotLLM: vi.fn() }));
vi.mock("../services/page-llm-config", () => ({ getPageFeatureSettings: vi.fn() }));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));

import { registerPixelOfficeHandlers } from "../ipc-handlers/pixel-office-handlers";
import {
	getTeamBoard,
	setTeamConsent,
	teamBoardRequest,
	toTeamBoard,
} from "../server-pixel-office";

const PROJECT = "3f6c2a10-0000-4000-8000-000000000001";
const ASK = { scope: "project", period: "season" } as const;

const answer = (extra: object = {}) => ({
	scope: "project",
	period: "season",
	season: { start: "2026-10-01T00:00:00+00:00", end: "2027-01-01T00:00:00+00:00" },
	projects: 1,
	entries: [
		{
			rank: 1,
			name: "  Ada \n Lovelace ",
			delivered: 2,
			reviews: 1,
			points: 6,
			badges: ["first_review", "first_delivery", "first_delivery"],
			you: true,
		},
	],
	me: {
		visible: true,
		delivered: 2,
		reviews: 1,
		points: 6,
		badges: ["first_delivery"],
		rank: 1,
	},
	...extra,
});

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.getServerProject.mockReset();
	mocks.getServerProject.mockImplementation((id: unknown) =>
		id === PROJECT ? { id: PROJECT } : undefined,
	);
	mocks.isServerMode.mockReturnValue(true);
});

describe("teamBoardRequest", () => {
	it("keeps a scope and a period from the closed lists only", () => {
		expect(teamBoardRequest({ scope: "org", period: "all", extra: 1 })).toEqual({
			scope: "org",
			period: "all",
		});
		for (const hostile of [
			null,
			[],
			"project",
			{ scope: "everyone", period: "season" },
			{ scope: "project", period: "forever" },
			{ scope: "project" },
			{ period: "season" },
		]) {
			expect(teamBoardRequest(hostile)).toBeNull();
		}
	});
});

describe("toTeamBoard", () => {
	it("reads the answer field by field", () => {
		const board = toTeamBoard(answer(), ASK);
		expect(board?.entries).toEqual([
			{
				rank: 1,
				name: "Ada Lovelace",
				delivered: 2,
				reviews: 1,
				points: 6,
				badges: ["first_delivery", "first_review"],
				you: true,
			},
		]);
		expect(board?.me).toEqual({
			visible: true,
			delivered: 2,
			reviews: 1,
			points: 6,
			badges: ["first_delivery"],
			rank: 1,
		});
		expect(board?.seasonStart).toBe("2026-10-01T00:00:00+00:00");
	});

	it("drops what is not a number, a known badge or a name", () => {
		const board = toTeamBoard(
			answer({
				projects: -2,
				entries: [
					{ rank: 2, name: "x".repeat(500), points: 1.5, badges: "first_review" },
					{ rank: 0, name: "Bob" },
					{ rank: 3, name: "   " },
					{ rank: 4, name: 7 },
					"Cy",
					{ rank: 5, name: "Dee", badges: ["<script>", 3, "ten_reviews"], you: "yes" },
				],
				me: { visible: "true", points: "9", rank: 0, badges: null },
			}),
			ASK,
		);
		expect(board?.projects).toBe(0);
		expect(board?.entries.map((e) => [e.rank, e.name.length, e.points])).toEqual([
			[2, 200, 0],
			[5, 3, 0],
		]);
		expect(board?.entries[1]).toMatchObject({ badges: ["ten_reviews"], you: false });
		expect(board?.me).toEqual({
			visible: false,
			delivered: 0,
			reviews: 0,
			points: 0,
			badges: [],
			rank: null,
		});
		expect(toTeamBoard(answer({ me: "nope" }), ASK)?.me.visible).toBe(false);
	});

	it("keeps at most fifty people", () => {
		const entries = Array.from({ length: 80 }, (_, i) => ({ rank: i + 1, name: `p${i}` }));
		expect(toTeamBoard(answer({ entries }), ASK)?.entries).toHaveLength(50);
	});

	it("refuses an answer that is not a board", () => {
		expect(toTeamBoard(null, ASK)).toBeNull();
		expect(toTeamBoard(answer({ entries: {} }), ASK)).toBeNull();
		expect(toTeamBoard(answer({ season: null }), ASK)).toBeNull();
		expect(toTeamBoard(answer({ season: { start: "soon", end: "later" } }), ASK)).toBeNull();
		expect(
			toTeamBoard(answer({ season: { start: "2026-10-01", end: "9".repeat(80) } }), ASK),
		).toBeNull();
	});
});

describe("getTeamBoard", () => {
	it("asks the server for a listed project, by id and closed lists", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: answer() });
		const result = await getTeamBoard(PROJECT, { scope: "org", period: "all" });
		expect(result.success).toBe(true);
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			`/api/features/pixel-office/leaderboard?project_id=${PROJECT}&scope=org&period=all`,
			"GET",
		);
		if (result.success) expect(result.board.scope).toBe("org");
	});

	it("refuses before any request for an unknown project or a bad request", async () => {
		await expect(getTeamBoard("../etc", ASK)).resolves.toEqual({
			success: false,
			error: "not_a_server_project",
		});
		await expect(getTeamBoard(PROJECT, { scope: "x", period: "all" })).resolves.toEqual({
			success: false,
			error: "Invalid leaderboard request",
		});
		mocks.isServerMode.mockReturnValue(false);
		await expect(getTeamBoard(PROJECT, ASK)).resolves.toMatchObject({ success: false });
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("passes the server's refusal and refuses a malformed answer", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Missing permission" });
		await expect(getTeamBoard(PROJECT, ASK)).resolves.toEqual({
			success: false,
			error: "Missing permission",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { entries: 3 } });
		await expect(getTeamBoard(PROJECT, ASK)).resolves.toEqual({
			success: false,
			error: "bad_leaderboard",
		});
	});
});

describe("setTeamConsent", () => {
	it("sends a boolean for a listed project", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { visible: true } });
		await expect(setTeamConsent(PROJECT, true)).resolves.toEqual({
			success: true,
			visible: true,
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			`/api/features/pixel-office/consent?project_id=${PROJECT}`,
			"PUT",
			{ visible: true },
		);
	});

	it("refuses anything but a boolean, and a malformed answer", async () => {
		for (const hostile of ["true", 1, null, { visible: true }]) {
			await expect(setTeamConsent(PROJECT, hostile)).resolves.toEqual({
				success: false,
				error: "Invalid consent",
			});
		}
		await expect(setTeamConsent("other", true)).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.authedFetch).not.toHaveBeenCalled();
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "nope" });
		await expect(setTeamConsent(PROJECT, false)).resolves.toEqual({
			success: false,
			error: "nope",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: "yes" });
		await expect(setTeamConsent(PROJECT, false)).resolves.toEqual({
			success: false,
			error: "bad_consent",
		});
	});
});

describe("the IPC channels", () => {
	it("hand the renderer's arguments to the checks above", async () => {
		registerPixelOfficeHandlers();
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { visible: false } });
		await expect(
			mocks.handlers.get(IPC_CHANNELS.PIXEL_OFFICE_TEAM_CONSENT)?.({}, PROJECT, false),
		).resolves.toEqual({ success: true, visible: false });
		await expect(
			mocks.handlers.get(IPC_CHANNELS.PIXEL_OFFICE_TEAM_BOARD)?.({}, PROJECT, "all"),
		).resolves.toEqual({ success: false, error: "Invalid leaderboard request" });
	});
});
