/**
 * Server mode: the live stream of a server board. The token travels in a
 * header, never in the URL; only card changes reach the window; a dropped
 * stream is opened again while the board is shown, and never after.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	token: "tok-0000" as string | null,
	org: "org-a" as string | null,
	url: "https://wp.example:9000" as string | null,
}));
const projects = vi.hoisted(() => ({ known: new Set(["p-1"]) }));

vi.mock("../server-connection", () => ({
	authedFetch: connection.authedFetch,
	getAccessToken: () => connection.token,
	getActiveOrgId: () => connection.org,
	getServerUrl: () => connection.url,
}));

vi.mock("../server-projects", () => ({
	getServerProject: (id: string) => (projects.known.has(id) ? { id } : undefined),
}));

class FakeSocket {
	static all: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(
		public url: string,
		public init: { headers: Record<string, string> },
	) {
		FakeSocket.all.push(this);
	}
	close() {
		this.closed = true;
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetModules();
	FakeSocket.all = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	connection.authedFetch.mockReset();
	connection.authedFetch.mockResolvedValue({ ok: true, data: { url: null } });
	connection.token = "tok-0000";
	projects.known = new Set(["p-1"]);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("where the stream is", () => {
	it("is the address the server names, else the API's host on the stream port", async () => {
		const { streamBase } = await import("../server-board-live");
		expect(streamBase("https://wp.example:9000", "wss://live.example/ws/")).toBe(
			"wss://live.example/ws",
		);
		expect(streamBase("https://wp.example:9000", null)).toBe("wss://wp.example:8765");
		expect(streamBase("http://10.0.0.5:9000/", "https://x")).toBe("ws://10.0.0.5:8765");
		expect(streamBase("http://[::1]:9000", null)).toBe("ws://[::1]:8765");
		expect(streamBase("file:///etc", null)).toBeNull();
		expect(streamBase("not a url", null)).toBeNull();
	});

	it("tells a card change from anything else", async () => {
		const { isBoardChange } = await import("../server-board-live");
		expect(isBoardChange(JSON.stringify({ event_type: "spec_updated" }))).toBe(true);
		expect(isBoardChange(JSON.stringify({ event_type: "agent_thinking" }))).toBe(false);
		expect(isBoardChange("{not json")).toBe(false);
		expect(isBoardChange(42)).toBe(false);
	});
});

describe("watching a server board", () => {
	it("authenticates in headers and reports changes to the window", async () => {
		const live = await import("../server-board-live");
		const updates: unknown[] = [];
		expect(live.watchServerBoard("p-1", (u) => updates.push(u))).toBe(true);
		await vi.advanceTimersByTimeAsync(0);

		const [socket] = FakeSocket.all;
		expect(socket.url).toBe("wss://wp.example:8765/stream/project%3Ap-1");
		expect(socket.url).not.toContain("tok-0000");
		expect(socket.init.headers).toEqual({
			Authorization: "Bearer tok-0000",
			"X-WorkPilot-Org": "org-a",
		});

		socket.onopen?.();
		expect(updates).toEqual([{ projectId: "p-1", live: true, changed: true }]);

		socket.onmessage?.({ data: JSON.stringify({ event_type: "agent_thinking" }) });
		socket.onmessage?.({ data: JSON.stringify({ event_type: "spec_created" }) });
		socket.onmessage?.({ data: JSON.stringify({ event_type: "spec_updated" }) });
		await vi.advanceTimersByTimeAsync(400);
		// Two changes close together: one read.
		expect(updates).toHaveLength(2);

		live.unwatchServerBoard("p-1");
		expect(socket.closed).toBe(true);
	});

	it("opens the stream again after it drops, and not once the board is closed", async () => {
		const live = await import("../server-board-live");
		const updates: Array<{ live: boolean }> = [];
		live.watchServerBoard("p-1", (u) => updates.push(u));
		await vi.advanceTimersByTimeAsync(0);
		FakeSocket.all[0].onclose?.();
		expect(updates.at(-1)?.live).toBe(false);

		await vi.advanceTimersByTimeAsync(2_000);
		expect(FakeSocket.all).toHaveLength(2);

		live.unwatchServerBoard("p-1");
		FakeSocket.all[1].onclose?.();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeSocket.all).toHaveLength(2);
	});

	it("opens nothing for a project that is not the server's, or without a session", async () => {
		const live = await import("../server-board-live");
		expect(live.watchServerBoard("local-1", () => {})).toBe(false);
		expect(live.watchServerBoard(42, () => {})).toBe(false);

		connection.token = null;
		live.watchServerBoard("p-1", () => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.all).toHaveLength(0);
		live.unwatchAllServerBoards();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeSocket.all).toHaveLength(0);
	});
});
