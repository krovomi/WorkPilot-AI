/**
 * Sharing a replay (#347): main asks the local backend for the masked file,
 * asks the person where to write it, and reads only the bundle they pick.
 *
 * The renderer gives a session id, closed-list options and bounded text;
 * anything else is refused before the backend is called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const dialogs = vi.hoisted(() => ({
	save: vi.fn(),
	open: vi.fn(),
}));
const files = vi.hoisted(() => {
	const state = { content: Buffer.from("bundle") };
	const handle = {
		stat: vi.fn(async () => ({ isFile: (): boolean => true, size: state.content.length })),
		read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
			const bytesRead = state.content.copy(buffer, offset, position, position + length);
			return { bytesRead };
		}),
		close: vi.fn(async () => undefined),
	};
	return {
		state,
		handle,
		writeFile: vi.fn(async () => undefined),
		open: vi.fn(async () => handle),
	};
});

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			handlers.set(channel, fn),
	},
}));
vi.mock("../../electron-utils", () => ({
	showSaveDialog: dialogs.save,
	showOpenDialog: dialogs.open,
}));
vi.mock("node:fs/promises", () => ({ writeFile: files.writeFile, open: files.open }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import {
	MAX_BUNDLE_BYTES,
	bookmarkBody,
	exportBody,
	exportedFile,
	registerReplayShareHandlers,
} from "../replay-share-handlers";

const fetchMock = vi.fn();

const call = (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<Record<string, unknown>>;
};

const ok = (body: object) =>
	new Response(JSON.stringify({ success: true, ...body }), { status: 200 });

const sent = (index = 0) => JSON.parse(fetchMock.mock.calls[index][1].body as string);

beforeEach(() => {
	handlers.clear();
	fetchMock.mockReset();
	dialogs.save.mockReset();
	dialogs.open.mockReset();
	files.writeFile.mockClear();
	files.open.mockClear();
	files.handle.read.mockClear();
	files.handle.close.mockClear();
	files.state.content = Buffer.from("bundle");
	files.handle.stat.mockReset();
	files.handle.stat.mockImplementation(async () => ({
		isFile: () => true,
		size: files.state.content.length,
	}));
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VITE_BACKEND_URL", "");
	vi.stubEnv("BACKEND_URL", "");
	registerReplayShareHandlers();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("exportBody", () => {
	it("keeps the closed-list options and defaults the rest", () => {
		expect(exportBody({ format: "html", stripTokens: true, language: "fr" })).toEqual({
			format: "html",
			strip_reasoning: false,
			strip_tokens: true,
			include_file_contents: false,
			language: "fr",
		});
		expect(exportBody({ format: "wpreplay", language: "de" })?.language).toBe("en");
	});

	it.each([
		null,
		"html",
		{},
		{ format: "exe" },
		{ format: "html", stripReasoning: "yes" },
		{ format: "html", includeFileContents: 1 },
	])("refuses %j", (raw) => {
		expect(exportBody(raw)).toBeNull();
	});
});

describe("bookmarkBody", () => {
	it("keeps a step, a note and an author", () => {
		expect(bookmarkBody({ stepIndex: 3, note: "see", author: "Ana" })).toEqual({
			step_index: 3,
			note: "see",
			author: "Ana",
		});
		expect(bookmarkBody({ stepIndex: 0, note: "" })?.author).toBe("");
	});

	it.each([
		null,
		7,
		{ stepIndex: -1, note: "" },
		{ stepIndex: 1.5, note: "" },
		{ stepIndex: 2_000_000, note: "" },
		{ stepIndex: "1", note: "" },
		{ stepIndex: 1 },
		{ stepIndex: 1, note: "x".repeat(4001) },
		{ stepIndex: 1, note: "", author: 5 },
		{ stepIndex: 1, note: "", author: "x".repeat(101) },
	])("refuses %j", (raw) => {
		expect(bookmarkBody(raw)).toBeNull();
	});
});

describe("exportedFile", () => {
	const gzip = Buffer.from([0x1f, 0x8b, 8, 0]);
	const page = Buffer.from("<!doctype html><html></html>");

	it("keeps a gzip bundle or a page, as asked", () => {
		expect(exportedFile(gzip.toString("base64"), "wpreplay")).toEqual(gzip);
		expect(exportedFile(page.toString("base64"), "html")).toEqual(page);
	});

	it.each([
		[7, "wpreplay"],
		["not base64!", "wpreplay"],
		["A".repeat(Math.ceil(MAX_BUNDLE_BYTES / 3) * 4 + 4), "wpreplay"],
		[page.toString("base64"), "wpreplay"],
		[gzip.toString("base64"), "html"],
	] as const)("refuses %#", (raw, format) => {
		expect(exportedFile(raw, format)).toBeNull();
	});
});

describe("export", () => {
	const content = Buffer.from([0x1f, 0x8b, 0]).toString("base64");

	it("writes the masked file where the person chooses", async () => {
		fetchMock.mockResolvedValueOnce(
			ok({ file_name: "../replay-bot.wpreplay", content_base64: content }),
		);
		dialogs.save.mockResolvedValueOnce({ canceled: false, filePath: "/out/r.wpreplay" });

		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_SESSION, "s-1", {
			format: "wpreplay",
			stripReasoning: true,
		});

		expect(result).toEqual({ success: true, filePath: "/out/r.wpreplay" });
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://127.0.0.1:9000/replay/sessions/s-1/export",
		);
		expect(sent()).toMatchObject({ format: "wpreplay", strip_reasoning: true });
		expect(dialogs.save.mock.calls[0][0]).toMatchObject({
			defaultPath: "replay-bot.wpreplay",
			filters: [{ name: "WPREPLAY", extensions: ["wpreplay"] }],
		});
		expect(files.writeFile).toHaveBeenCalledWith(
			"/out/r.wpreplay",
			Buffer.from([0x1f, 0x8b, 0]),
		);
		// Counted on this machine once written, by its kind only.
		expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:9000/replay/usage/exports");
		expect(sent(1)).toEqual({ kind: "wpreplay" });
	});

	it("writes nothing the backend did not build as asked", async () => {
		fetchMock.mockResolvedValueOnce(ok({ file_name: "p.html", content_base64: content }));
		dialogs.save.mockResolvedValueOnce({ canceled: false, filePath: "/out/p.html" });

		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_SESSION, "s-1", {
			format: "html",
		});

		expect(result).toEqual({ success: false, error: "bad_export" });
		expect(files.writeFile).not.toHaveBeenCalled();
	});

	it("writes nothing when the person closes the dialog", async () => {
		fetchMock.mockResolvedValueOnce(ok({ file_name: "p.html", content_base64: content }));
		dialogs.save.mockResolvedValueOnce({ canceled: true });

		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_SESSION, "s-1", {
			format: "html",
		});

		expect(result).toEqual({ success: true, canceled: true });
		expect(files.writeFile).not.toHaveBeenCalled();
		// A closed dialog is not an export.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("passes the backend's refusal on and asks for no file", async () => {
		fetchMock.mockResolvedValueOnce(new Response('{"detail":"nope"}', { status: 404 }));

		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_SESSION, "s-1", {
			format: "html",
		});

		expect(result).toEqual({ success: false, error: '{"detail":"nope"}' });
		expect(dialogs.save).not.toHaveBeenCalled();
	});

	it("refuses a bad id or bad options before the backend", async () => {
		expect(
			await call(IPC_CHANNELS.REPLAY_EXPORT_SESSION, "../x", { format: "html" }),
		).toEqual({ success: false, error: "Invalid session id" });
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_SESSION, "s-1", { format: "x" })).toEqual(
			{ success: false, error: "Invalid export options" },
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("import", () => {
	it("sends the picked bundle to the backend", async () => {
		dialogs.open.mockResolvedValueOnce({ canceled: false, filePaths: ["/in/a.wpreplay"] });
		fetchMock.mockResolvedValueOnce(ok({ session: { session_id: "n1", agent_name: "Bot" } }));

		const result = await call(IPC_CHANNELS.REPLAY_IMPORT_SESSION);

		expect(result).toEqual({
			success: true,
			session: { session_id: "n1", agent_name: "Bot" },
		});
		expect(files.open).toHaveBeenCalledWith("/in/a.wpreplay", "r");
		expect(files.handle.close).toHaveBeenCalled();
		expect(sent()).toEqual({ content_base64: Buffer.from("bundle").toString("base64") });
	});

	it("reads nothing when the person closes the dialog", async () => {
		dialogs.open.mockResolvedValueOnce({ canceled: true, filePaths: [] });
		expect(await call(IPC_CHANNELS.REPLAY_IMPORT_SESSION)).toEqual({
			success: true,
			canceled: true,
		});
		dialogs.open.mockResolvedValueOnce({ canceled: false });
		expect(await call(IPC_CHANNELS.REPLAY_IMPORT_SESSION)).toEqual({
			success: true,
			canceled: true,
		});
		expect(files.open).not.toHaveBeenCalled();
	});

	it("refuses a folder or a file larger than a bundle", async () => {
		dialogs.open.mockResolvedValue({ canceled: false, filePaths: ["/in/x"] });
		files.handle.stat.mockResolvedValueOnce({ isFile: () => false, size: 0 });
		expect(await call(IPC_CHANNELS.REPLAY_IMPORT_SESSION)).toEqual({
			success: false,
			error: "not_a_file",
		});
		files.handle.stat.mockResolvedValueOnce({ isFile: () => true, size: MAX_BUNDLE_BYTES + 1 });
		expect(await call(IPC_CHANNELS.REPLAY_IMPORT_SESSION)).toEqual({
			success: false,
			error: "too_large",
		});
		expect(files.handle.read).not.toHaveBeenCalled();
		expect(files.handle.close).toHaveBeenCalledTimes(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a file that grows past a bundle while it is read", async () => {
		dialogs.open.mockResolvedValue({ canceled: false, filePaths: ["/in/x"] });
		files.state.content = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
		files.handle.stat.mockResolvedValueOnce({ isFile: () => true, size: 6 });
		expect(await call(IPC_CHANNELS.REPLAY_IMPORT_SESSION)).toEqual({
			success: false,
			error: "too_large",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("bookmarks", () => {
	it("adds a checked bookmark", async () => {
		fetchMock.mockResolvedValueOnce(ok({ bookmark: { id: "b1" } }));

		const result = await call(IPC_CHANNELS.REPLAY_ADD_BOOKMARK, "s-1", {
			stepIndex: 2,
			note: "here",
		});

		expect(result).toEqual({ success: true, bookmark: { id: "b1" } });
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://127.0.0.1:9000/replay/sessions/s-1/bookmarks",
		);
		expect(sent()).toEqual({ step_index: 2, note: "here", author: "" });
	});

	it("refuses a bad id or bookmark", async () => {
		expect(await call(IPC_CHANNELS.REPLAY_ADD_BOOKMARK, "a/b", { stepIndex: 0, note: "" }))
			.toEqual({ success: false, error: "Invalid session id" });
		expect(await call(IPC_CHANNELS.REPLAY_ADD_BOOKMARK, "s-1", { stepIndex: -2 })).toEqual({
			success: false,
			error: "Invalid bookmark",
		});
		expect(await call(IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK, "s-1", "../b")).toEqual({
			success: false,
			error: "Invalid bookmark id",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("removes a bookmark", async () => {
		fetchMock.mockResolvedValueOnce(ok({}));

		expect(await call(IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK, "s-1", "b1")).toEqual({
			success: true,
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://127.0.0.1:9000/replay/sessions/s-1/bookmarks/b1",
		);
		expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
	});
});
