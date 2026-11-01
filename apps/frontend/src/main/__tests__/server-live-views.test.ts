/**
 * Server mode: the shared views of a server project follow its live stream.
 * One socket per project, shared with the board; one reference per shown
 * view, released when the view closes or its window does; a teammate's
 * change reaches only the window showing that view, and the person's own
 * changes are not sent back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	token: "tok-0000" as string | null,
	me: "u-me" as string | null,
}));
const projects = vi.hoisted(() => ({ known: new Set(["p-1", "p-2"]) }));

vi.mock("../server-connection", () => ({
	authedFetch: connection.authedFetch,
	getAccessToken: () => connection.token,
	getActiveOrgId: () => "org-a",
	getServerUrl: () => "https://wp.example:9000",
	getAuthState: () => ({ user: connection.me ? { id: connection.me } : null }),
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
	send(event_type: string, data: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify({ event_type, data }) });
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
	connection.me = "u-me";
	projects.known = new Set(["p-1", "p-2"]);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const WINDOW = 7;
const OTHER_WINDOW = 8;

async function load() {
	const views = await import("../server-live-views");
	const board = await import("../server-board-live");
	const stream = await import("../server-project-stream");
	return { views, board, stream };
}

describe("one stream per project, counted by view", () => {
	it("shares the board's socket and closes with the last view shown", async () => {
		const { views, board, stream } = await load();
		const changes: unknown[] = [];
		expect(views.watchServerView(WINDOW, "p-1", "roadmap", (c) => changes.push(c))).toBe(true);
		expect(board.watchServerBoard("p-1", () => undefined)).toBe(true);
		expect(views.watchServerView(WINDOW, "p-1", "roadmap", (c) => changes.push(c))).toBe(true);
		expect(views.watchServerView(WINDOW, "p-1", "insights", (c) => changes.push(c))).toBe(true);
		await vi.advanceTimersByTimeAsync(0);

		// The board and three views: still one socket, the token in a header.
		expect(FakeSocket.all).toHaveLength(1);
		expect(FakeSocket.all[0].url).toBe("wss://wp.example:8765/stream/project%3Ap-1");
		expect(FakeSocket.all[0].url).not.toContain("tok-0000");
		expect(views.watchedViews(WINDOW, "p-1")).toEqual({ roadmap: 2, insights: 1 });

		board.unwatchServerBoard("p-1");
		views.unwatchServerView(WINDOW, "p-1", "roadmap");
		views.unwatchServerView(WINDOW, "p-1", "insights");
		expect(FakeSocket.all[0].closed).toBe(false);
		expect(views.watchedViews(WINDOW, "p-1")).toEqual({ roadmap: 1 });

		views.unwatchServerView(WINDOW, "p-1", "roadmap");
		expect(FakeSocket.all[0].closed).toBe(true);
		expect(stream.streamHolders("p-1")).toBe(0);
		// One release too many changes nothing.
		views.unwatchServerView(WINDOW, "p-1", "roadmap");
		expect(views.watchedViews(WINDOW, "p-1")).toEqual({});
	});

	it("releases a closed window's views, and every view at sign-out", async () => {
		const { views, stream } = await load();
		views.watchServerView(WINDOW, "p-1", "roadmap", () => undefined);
		views.watchServerView(WINDOW, "p-2", "context", () => undefined);
		views.watchServerView(OTHER_WINDOW, "p-1", "ideation", () => undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.all).toHaveLength(2);

		views.unwatchWindowViews(WINDOW);
		expect(stream.streamHolders("p-1")).toBe(1);
		expect(stream.streamHolders("p-2")).toBe(0);

		views.unwatchAllServerViews();
		expect(stream.streamHolders("p-1")).toBe(0);
		expect(FakeSocket.all.every((socket) => socket.closed)).toBe(true);
	});

	it("refuses a view that is not shared or a project that is not the server's", async () => {
		const { views } = await load();
		expect(views.watchServerView(WINDOW, "p-1", "terminals", () => undefined)).toBe(false);
		expect(views.watchServerView(WINDOW, "p-1", 42, () => undefined)).toBe(false);
		expect(views.watchServerView(WINDOW, "local-1", "roadmap", () => undefined)).toBe(false);
		expect(views.watchServerView(WINDOW, { id: "p-1" }, "roadmap", () => undefined)).toBe(false);
		expect(views.watchServerView(Number.NaN, "p-1", "roadmap", () => undefined)).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.all).toHaveLength(0);
	});
});

describe("a teammate's change", () => {
	it("reaches the window showing that view, once per burst", async () => {
		const { views } = await load();
		const mine: unknown[] = [];
		const other: unknown[] = [];
		views.watchServerView(WINDOW, "p-1", "roadmap", (c) => mine.push(c));
		views.watchServerView(OTHER_WINDOW, "p-1", "ideation", (c) => other.push(c));
		await vi.advanceTimersByTimeAsync(0);
		const [socket] = FakeSocket.all;
		socket.onopen?.();

		socket.send("feature_job", { feature: "roadmap", status: "queued", by: "u-2" });
		socket.send("feature_updated", { feature: "roadmap", file: "roadmap.json", by: "u-2" });
		await vi.advanceTimersByTimeAsync(400);
		expect(mine).toEqual([{ projectId: "p-1", view: "roadmap" }]);
		expect(other).toEqual([]);

		socket.send("feature_updated", { feature: "ideation", file: "ideation.json", by: "u-2" });
		await vi.advanceTimersByTimeAsync(400);
		expect(other).toEqual([{ projectId: "p-1", view: "ideation" }]);
		expect(mine).toHaveLength(1);
	});

	it("is not sent back to the person who made it", async () => {
		const { views } = await load();
		const changes: unknown[] = [];
		views.watchServerView(WINDOW, "p-1", "roadmap", (c) => changes.push(c));
		views.watchServerView(WINDOW, "p-1", "insights", (c) => changes.push(c));
		await vi.advanceTimersByTimeAsync(0);
		const [socket] = FakeSocket.all;
		socket.send("feature_updated", { feature: "roadmap", file: "roadmap.json", by: "u-me" });
		socket.send("insights_updated", { session_id: "s-1", by: "u-me", deleted: false });
		await vi.advanceTimersByTimeAsync(400);
		expect(changes).toEqual([]);
	});

	it("reads only names from closed lists", async () => {
		const { views } = await load();
		const me = "u-me";
		const change = (type: string, data: Record<string, unknown>) =>
			views.viewChange("p-1", { type, data }, me);

		expect(change("insights_updated", { session_id: "s-1", by: "u-2" })).toEqual({
			projectId: "p-1",
			view: "insights",
			sessionId: "s-1",
		});
		expect(change("insights_updated", { session_id: "../x", by: "u-2" })).toEqual({
			projectId: "p-1",
			view: "insights",
		});
		expect(change("spec_status_changed", { run_status: "succeeded", user_id: me })).toEqual({
			projectId: "p-1",
			view: "context",
			memoriesOnly: true,
		});
		expect(change("spec_status_changed", { run_status: "running" })).toBeNull();
		expect(change("feature_job", { feature: "forge/github/reviews", by: "u-2" })).toBeNull();
		expect(change("feature_updated", { feature: "terminals", by: "u-2" })).toBeNull();
		expect(change("spec_created", { spec: "001-x", by: "u-2" })).toBeNull();
	});

	it("is read again after the stream comes back, not on its first opening", async () => {
		const { views } = await load();
		const changes: unknown[] = [];
		views.watchServerView(WINDOW, "p-1", "context", (c) => changes.push(c));
		await vi.advanceTimersByTimeAsync(0);
		FakeSocket.all[0].onopen?.();
		await vi.advanceTimersByTimeAsync(400);
		expect(changes).toEqual([]);

		FakeSocket.all[0].onclose?.();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(FakeSocket.all).toHaveLength(2);
		FakeSocket.all[1].onopen?.();
		await vi.advanceTimersByTimeAsync(400);
		expect(changes).toEqual([{ projectId: "p-1", view: "context" }]);
	});

	it("is dropped once the view is closed", async () => {
		const { views, board } = await load();
		const changes: unknown[] = [];
		board.watchServerBoard("p-1", () => undefined);
		views.watchServerView(WINDOW, "p-1", "roadmap", (c) => changes.push(c));
		await vi.advanceTimersByTimeAsync(0);
		const [socket] = FakeSocket.all;
		socket.send("feature_updated", { feature: "roadmap", by: "u-2" });
		views.unwatchServerView(WINDOW, "p-1", "roadmap");
		await vi.advanceTimersByTimeAsync(400);
		expect(changes).toEqual([]);
		// The board still holds the stream.
		expect(socket.closed).toBe(false);
	});
});
