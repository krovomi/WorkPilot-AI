/**
 * Answering a bookmark (#347): the renderer gives ids of the replay store's
 * charset and a bounded, non-empty note; anything else is refused before the
 * backend is asked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			handlers.set(channel, fn),
	},
}));
vi.mock("../../electron-utils", () => ({ showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerReplayShareHandlers, replyBody } from "../replay-share-handlers";

const fetchMock = vi.fn();
const call = (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<Record<string, unknown>>;
};
const ok = (body: object) =>
	new Response(JSON.stringify({ success: true, ...body }), { status: 200 });

beforeEach(() => {
	handlers.clear();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VITE_BACKEND_URL", "");
	vi.stubEnv("BACKEND_URL", "");
	registerReplayShareHandlers();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("replyBody", () => {
	it("keeps a note and an author", () => {
		expect(replyBody({ note: "agreed" })).toEqual({ note: "agreed", author: "" });
		expect(replyBody({ note: "n", author: "Bob" })).toEqual({ note: "n", author: "Bob" });
	});

	it.each([
		null,
		"x",
		{},
		{ note: "   " },
		{ note: 3 },
		{ note: "x".repeat(4001) },
		{ note: "n", author: 4 },
		{ note: "n", author: "a".repeat(101) },
	])("refuses %j", (raw) => {
		expect(replyBody(raw)).toBeNull();
	});
});

describe("REPLAY_ADD_BOOKMARK_REPLY and REPLAY_REMOVE_BOOKMARK_REPLY", () => {
	it("answers a bookmark on the backend", async () => {
		fetchMock.mockResolvedValueOnce(ok({ reply: { id: "r1" } }));
		const result = await call(IPC_CHANNELS.REPLAY_ADD_BOOKMARK_REPLY, "s-1", "b1", {
			note: "agreed",
		});
		expect(result).toMatchObject({ success: true, reply: { id: "r1" } });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/replay/sessions/s-1/bookmarks/b1/replies");
		expect(JSON.parse(String(init.body))).toEqual({ note: "agreed", author: "" });
	});

	it("removes a reply", async () => {
		fetchMock.mockResolvedValueOnce(ok({}));
		expect(
			await call(IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK_REPLY, "s-1", "b1", "r1"),
		).toEqual({ success: true });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/replay/sessions/s-1/bookmarks/b1/replies/r1");
		expect(init.method).toBe("DELETE");
	});

	it("refuses bad ids and notes before asking", async () => {
		const add = IPC_CHANNELS.REPLAY_ADD_BOOKMARK_REPLY;
		const remove = IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK_REPLY;
		expect((await call(add, "../s", "b1", { note: "n" })).error).toBe("Invalid bookmark id");
		expect((await call(add, "s-1", "b/1", { note: "n" })).error).toBe("Invalid bookmark id");
		expect((await call(add, "s-1", "b1", { note: "" })).error).toBe("Invalid reply");
		expect((await call(remove, "s-1", "b1", "../r")).error).toBe("Invalid reply id");
		expect((await call(remove, "s/1", "b1", "r1")).error).toBe("Invalid reply id");
		expect((await call(remove, "s-1", 3, "r1")).error).toBe("Invalid reply id");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
