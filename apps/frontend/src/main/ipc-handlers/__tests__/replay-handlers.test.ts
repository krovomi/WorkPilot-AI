/**
 * Agent Replay and Session History reach the local backend through main.
 *
 * The renderer fetched `${VITE_BACKEND_URL}/replay/...` with a variable that
 * is never set there: the relative URL reached the Vite dev server, which
 * answered its HTML page, and the view said the backend did not answer while
 * it ran. Main targets the backend the app starts; the renderer only names ids,
 * checked here because they become a file name in the backend's replay store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			handlers.set(channel, fn),
	},
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { breakpointBody, registerReplayHandlers } from "../replay-handlers";

const fetchMock = vi.fn();

const call = (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<Record<string, unknown>>;
};

const ok = (body: object) =>
	new Response(JSON.stringify({ success: true, ...body }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

beforeEach(() => {
	handlers.clear();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VITE_BACKEND_URL", "");
	vi.stubEnv("BACKEND_URL", "");
	registerReplayHandlers();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("replay handlers", () => {
	it("list the sessions from the backend the app starts", async () => {
		fetchMock.mockResolvedValueOnce(ok({ sessions: [{ session_id: "a1" }] }));

		const result = await call(IPC_CHANNELS.REPLAY_LIST_SESSIONS);

		expect(result).toEqual({ success: true, sessions: [{ session_id: "a1" }] });
		expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9000/replay/sessions");
	});

	it("say the backend did not answer when nothing listens", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

		const result = await call(IPC_CHANNELS.REPLAY_LIST_SESSIONS);

		expect(result).toMatchObject({ success: false, unreachable: true });
	});

	it("keep an error the backend gave apart from an unreachable backend", async () => {
		fetchMock.mockResolvedValueOnce(new Response("Replay session not found", { status: 404 }));

		const result = await call(IPC_CHANNELS.REPLAY_GET_SESSION, "abc123");

		expect(result).toEqual({ success: false, error: "Replay session not found" });
	});

	it.each([
		["../../etc/passwd"],
		["a/b"],
		[""],
		[42],
		["x".repeat(129)],
	])("refuse the session id %j without calling the backend", async (id) => {
		for (const channel of [
			IPC_CHANNELS.REPLAY_GET_SESSION,
			IPC_CHANNELS.REPLAY_DELETE_SESSION,
			IPC_CHANNELS.REPLAY_GET_HEATMAP,
		]) {
			expect(await call(channel, id)).toMatchObject({ success: false });
		}
		expect(await call(IPC_CHANNELS.REPLAY_COMPARE, "ok1", id)).toMatchObject({
			success: false,
		});
		expect(await call(IPC_CHANNELS.REPLAY_REMOVE_BREAKPOINT, "ok1", id)).toMatchObject({
			success: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("compare two sessions with the body the backend expects", async () => {
		fetchMock.mockResolvedValueOnce(ok({ comparison: {} }));

		await call(IPC_CHANNELS.REPLAY_COMPARE, "a1", "b2");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/replay/compare");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body)).toEqual({ session_a_id: "a1", session_b_id: "b2" });
	});

	it("add a breakpoint only of a known type, with bounded text", async () => {
		fetchMock.mockResolvedValueOnce(ok({ breakpoint: { id: "bp1" } }));

		await call(IPC_CHANNELS.REPLAY_ADD_BREAKPOINT, "a1", {
			breakpoint_type: "tool_call",
			condition: "Bash",
			extra: "dropped",
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/replay/sessions/a1/breakpoints");
		expect(JSON.parse(init.body)).toEqual({
			breakpoint_type: "tool_call",
			condition: "Bash",
			description: "",
		});
		expect(breakpointBody({ breakpoint_type: "shell" })).toBeNull();
		expect(breakpointBody({ breakpoint_type: "error", condition: "x".repeat(2001) })).toBeNull();
		expect(breakpointBody(null)).toBeNull();
	});

	it("read the session history of a project, its id encoded", async () => {
		fetchMock.mockResolvedValueOnce(ok({ sessions: [] }));

		await call(IPC_CHANNELS.SESSION_HISTORY_LIST, "p 1/2");

		expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9000/api/sessions/p%201%2F2");
		expect(await call(IPC_CHANNELS.SESSION_HISTORY_LIST, 7)).toMatchObject({
			success: false,
		});
	});
});
