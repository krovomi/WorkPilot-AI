/**
 * @vitest-environment node
 *
 * The team room of a server board: what the server sends on the project's
 * stream is checked and bounded before the window sees it, teammates'
 * arrivals and actions become notices (never my own), the claims are read
 * again after a board event, and a chat message goes out only on an open
 * stream of a joined room.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRoomUpdate } from "../../shared/types";

const PID = "6f1c2b9e-0d4a-4c1e-9a7b-1f2e3d4c5b6a";

const fake = vi.hoisted(() => ({
	holder: null as null | {
		onLive(live: boolean): void;
		onEvent(event: { type: string; data: Record<string, unknown> }): void;
	},
	released: 0,
	sent: [] as object[],
	open: true,
	authedFetch: vi.fn(),
}));

vi.mock("../server-project-stream", () => ({
	holdProjectStream: (projectId: string, holder: typeof fake.holder) => {
		if (projectId !== PID) return null;
		fake.holder = holder;
		return () => {
			fake.released += 1;
		};
	},
	sendOnProjectStream: (_projectId: string, message: object) => {
		if (!fake.open) return false;
		fake.sent.push(message);
		return true;
	},
}));

vi.mock("../server-projects", () => ({
	getServerProject: (id: string) => (id === PID ? { id: PID, path: "/mirror" } : undefined),
}));

vi.mock("../server-connection", () => ({
	authedFetch: fake.authedFetch,
	getAuthState: () => ({ user: { id: "me", display_name: "Me", email: "me@example.com" } }),
}));

vi.mock("../server-board-actions", () => ({
	findServerCard: (taskId: string) =>
		taskId === `server:${PID}:001-login`
			? { project: { id: PID }, cardId: "001-login" }
			: null,
	serverCardIndexId: async () => ({ success: true, data: "idx-1" }),
}));

import {
	joinTeamRoom,
	leaveTeamRoom,
	releaseCardClaim,
	sendTeamChat,
} from "../server-team-room";

const SPECS = [
	{ spec_name: "001-login", claimed_by: "u-ann", claimed_by_name: "Ann" },
	{ spec_name: "002-free", claimed_by: null },
	{ spec_name: "../evil", claimed_by: "u-x" },
	"not a row",
];

let updates: TeamRoomUpdate[];

function join() {
	updates = [];
	expect(joinTeamRoom(PID, (u) => updates.push(u))).toBe(true);
}

function emit(type: string, data: Record<string, unknown>) {
	fake.holder?.onEvent({ type, data });
}

const ofKind = <K extends TeamRoomUpdate["kind"]>(kind: K) =>
	updates.filter((u): u is Extract<TeamRoomUpdate, { kind: K }> => u.kind === kind);

beforeEach(() => {
	vi.useFakeTimers();
	fake.holder = null;
	fake.released = 0;
	fake.sent = [];
	fake.open = true;
	fake.authedFetch.mockReset();
	fake.authedFetch.mockResolvedValue({ ok: true, data: SPECS });
});

afterEach(() => {
	leaveTeamRoom(PID);
	vi.useRealTimers();
});

describe("team room", () => {
	it("joins only a server project, and leaves its stream", () => {
		expect(joinTeamRoom("local-project", () => undefined)).toBe(false);
		join();
		expect(ofKind("state").at(-1)).toMatchObject({ live: false, me: { id: "me", name: "Me" } });
		leaveTeamRoom(PID);
		expect(fake.released).toBe(1);
	});

	it("reads the claims when the stream opens, keeping only real cards", async () => {
		join();
		fake.holder?.onLive(true);
		await vi.runAllTimersAsync();
		expect(fake.authedFetch).toHaveBeenCalledWith(`/projects/${PID}/specs`, "GET");
		expect(ofKind("state").at(-1)?.locks).toEqual([
			{ taskId: `server:${PID}:001-login`, cardId: "001-login", userId: "u-ann", userName: "Ann" },
		]);
	});

	it("tells of arrivals and departures after the first roster, never of me", () => {
		join();
		fake.holder?.onLive(true);
		emit("presence", { users: [{ id: "me", name: "Me" }, { id: "u-ann", name: "Ann" }] });
		expect(ofKind("activity")).toEqual([]);
		emit("presence", {
			users: [
				{ id: "me", name: "Me" },
				{ id: "u-bob", name: "Bob" },
				{ id: 7, name: "bad" },
			],
		});
		expect(ofKind("activity").map((u) => u.activity)).toEqual([
			{ type: "joined", user: "Bob" },
			{ type: "left", user: "Ann" },
		]);
		expect(ofKind("state").at(-1)?.users).toEqual([
			{ id: "me", name: "Me" },
			{ id: "u-bob", name: "Bob" },
		]);
		// A dropped stream empties the roster; the next one is a baseline again.
		fake.holder?.onLive(false);
		expect(ofKind("state").at(-1)).toMatchObject({ live: false, users: [] });
	});

	it("passes the history and new messages, dropping what is not one", () => {
		join();
		const ok = { id: "m1", author_id: "u-ann", author: "Ann", message: "hi", reply_to: "", at: "2026-11-02T10:00:00+00:00" };
		emit("chat_history", { messages: [ok, { ...ok, id: "", message: "no id" }, { ...ok, id: "m2", message: "x".repeat(2001) }] });
		emit("chat_message", { ...ok, id: "m3", message: "again" });
		emit("chat_message", { nope: true });
		expect(ofKind("chat")).toEqual([
			{
				kind: "chat",
				projectId: PID,
				replace: true,
				messages: [{ id: "m1", authorId: "u-ann", author: "Ann", message: "hi", replyTo: "", at: ok.at }],
			},
			{
				kind: "chat",
				projectId: PID,
				replace: false,
				messages: [{ id: "m3", authorId: "u-ann", author: "Ann", message: "again", replyTo: "", at: ok.at }],
			},
		]);
		emit("chat_rejected", { reason: "too_fast" });
		emit("chat_rejected", { reason: "<script>" });
		expect(ofKind("rejected").map((u) => u.reason)).toEqual(["too_fast"]);
	});

	it("tells of a teammate's claim and run, not mine, and reads the claims again", async () => {
		join();
		emit("spec_claimed", { spec_name: "001-login", user_id: "u-ann", user_name: "Ann" });
		emit("spec_claimed", { spec_name: "002-free", user_id: "me", user_name: "Me" });
		emit("spec_status_changed", {
			spec_name: "001-login",
			user_id: "u-ann",
			user_name: "Ann",
			phase: "build",
			run_status: "failed",
		});
		emit("spec_status_changed", { spec_name: "001-login", user_id: "u-ann", run_status: "running" });
		expect(ofKind("activity").map((u) => u.activity)).toEqual([
			{ type: "claimed", user: "Ann", card: "001-login" },
			{ type: "run_finished", user: "Ann", card: "001-login", phase: "build", status: "failed" },
		]);
		await vi.runAllTimersAsync();
		// Four events, one read: they are gathered.
		expect(fake.authedFetch).toHaveBeenCalledTimes(1);
	});
});

describe("team chat", () => {
	it("sends a trimmed message on the open stream of a joined room only", () => {
		expect(sendTeamChat(PID, "hi", "")).toEqual({ success: false, error: "notJoined" });
		join();
		expect(sendTeamChat(PID, "  hi  ", "m1")).toEqual({ success: true });
		expect(fake.sent).toEqual([{ type: "chat_message", message: "hi", reply_to: "m1" }]);
		expect(sendTeamChat(PID, "   ", "")).toEqual({ success: false, error: "invalid" });
		expect(sendTeamChat(PID, "x".repeat(2001), "")).toEqual({ success: false, error: "invalid" });
		expect(sendTeamChat(PID, { evil: 1 }, "")).toEqual({ success: false, error: "invalid" });
		fake.open = false;
		expect(sendTeamChat(PID, "hi", "")).toEqual({ success: false, error: "offline" });
	});

	it("releases a card's claim through the server, which decides who may", async () => {
		fake.authedFetch.mockResolvedValueOnce({ ok: false, error: "Only the claim holder or an owner can release" });
		expect(await releaseCardClaim(`server:${PID}:001-login`)).toEqual({
			success: false,
			error: "Only the claim holder or an owner can release",
		});
		expect(fake.authedFetch).toHaveBeenCalledWith(`/projects/${PID}/specs/idx-1/release`, "POST");
		expect(await releaseCardClaim("local-task")).toEqual({ success: false, error: "notFound" });
	});
});
