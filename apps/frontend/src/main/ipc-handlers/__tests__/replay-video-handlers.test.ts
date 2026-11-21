/**
 * A replay as a video, and a model's summary of its steps (#347, lot 2).
 *
 * The renderer gives a session id, booleans, a language and a provider name;
 * anything else is refused before the backend is called. Main writes only a
 * WebM within the bound, in the folder the person chose, resolved, under a
 * `.webm` name, never through a link. Files are real, in a temporary folder.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const dialogs = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			handlers.set(channel, fn),
	},
}));
vi.mock("../../electron-utils", () => ({ showSaveDialog: dialogs.save }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import {
	MAX_VIDEO_BYTES,
	exportedVideo,
	registerReplayVideoHandlers,
	saveTarget,
	summaryBody,
	videoBody,
	writeVideo,
} from "../replay-video-handlers";

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);
const fetchMock = vi.fn();
let dir = "";

const call = (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<Record<string, unknown>>;
};

const answer = (body: object, status = 200) =>
	new Response(JSON.stringify(body), { status });

const recorded = (extra: object = {}) =>
	answer({
		success: true,
		available: true,
		file_name: "../../replay-coder.webm",
		content_base64: WEBM.toString("base64"),
		steps_played: 3,
		steps_total: 5,
		...extra,
	});

beforeEach(() => {
	handlers.clear();
	fetchMock.mockReset();
	dialogs.save.mockReset();
	dir = mkdtempSync(path.join(tmpdir(), "wp-replay-video-"));
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("VITE_BACKEND_URL", "");
	vi.stubEnv("BACKEND_URL", "");
	registerReplayVideoHandlers();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("videoBody", () => {
	it("keeps booleans and a language from the closed list", () => {
		expect(videoBody({ stripTokens: true, language: "fr" })).toEqual({
			strip_reasoning: false,
			strip_tokens: true,
			language: "fr",
			format: "webm",
		});
		expect(videoBody({ stripReasoning: true, language: "de" })).toEqual({
			strip_reasoning: true,
			strip_tokens: false,
			language: "en",
			format: "webm",
		});
	});

	it.each([null, "x", { stripReasoning: "yes" }, { stripTokens: 1 }])("refuses %j", (raw) => {
		expect(videoBody(raw)).toBeNull();
	});
});

describe("summaryBody", () => {
	it("keeps a provider name and a language", () => {
		expect(summaryBody({ provider: "lm-studio", language: "fr" })).toEqual({
			provider: "lm-studio",
			language: "fr",
		});
		expect(summaryBody({ provider: "claude" })?.language).toBe("en");
	});

	it.each([
		null,
		{},
		{ provider: 3 },
		{ provider: "" },
		{ provider: "Claude" },
		{ provider: "../etc" },
		{ provider: "a b" },
		{ provider: "a".repeat(41) },
	])("refuses %j", (raw) => {
		expect(summaryBody(raw)).toBeNull();
	});
});

describe("exportedVideo", () => {
	it("keeps a WebM within the bound", () => {
		expect(exportedVideo(WEBM.toString("base64"))?.equals(WEBM)).toBe(true);
	});

	it("refuses what is not one", () => {
		expect(exportedVideo(3)).toBeNull();
		expect(exportedVideo("@@")).toBeNull();
		expect(exportedVideo(Buffer.from("<!doctype html>").toString("base64"))).toBeNull();
		expect(exportedVideo("A".repeat(Math.ceil(MAX_VIDEO_BYTES / 3) * 4 + 4))).toBeNull();
	});

	it("refuses one that decodes past the bound", () => {
		const encoded = "A".repeat(Math.ceil(MAX_VIDEO_BYTES / 3) * 4);
		expect(Buffer.from(encoded, "base64").length).toBeGreaterThan(MAX_VIDEO_BYTES);
		expect(exportedVideo(encoded)).toBeNull();
	});
});

describe("saveTarget", () => {
	it("resolves the folder and ends the name in .webm", async () => {
		const real = path.join(dir, "real");
		mkdirSync(real);
		const link = path.join(dir, "link");
		symlinkSync(real, link, "dir");
		const resolved = await saveTarget(path.join(link, "demo"));
		expect(resolved).toBe(path.join(realpathSync(real), "demo.webm"));
		expect(await saveTarget(path.join(real, "demo.WEBM"))).toMatch(/demo\.WEBM$/);
	});

	it("refuses a link, a folder or a missing folder in its place", async () => {
		const outside = path.join(dir, "outside.webm");
		writeFileSync(outside, "x");
		symlinkSync(outside, path.join(dir, "trap.webm"));
		mkdirSync(path.join(dir, "folder.webm"));
		writeFileSync(path.join(dir, "file"), "x");
		expect(await saveTarget(path.join(dir, "trap.webm"))).toBeNull();
		expect(await saveTarget(path.join(dir, "folder.webm"))).toBeNull();
		expect(await saveTarget(path.join(dir, "missing", "a.webm"))).toBeNull();
		expect(await saveTarget(path.join(dir, "file", "a.webm"))).toBeNull();
		expect(await saveTarget("")).toBeNull();
		expect(await saveTarget(`${dir}/a\0.webm`)).toBeNull();
		expect(await saveTarget(`${dir}/..`)).toBeNull();
		expect(await saveTarget(path.join(dir, "kept.webm"))).toBe(
			path.join(realpathSync(dir), "kept.webm"),
		);
	});
});

describe("writeVideo", () => {
	it("writes a new file and replaces a file of its own", async () => {
		const target = path.join(dir, "a.webm");
		expect(await writeVideo(target, WEBM)).toBe(true);
		writeFileSync(target, "older and longer content");
		expect(await writeVideo(target, WEBM)).toBe(true);
		expect(readFileSync(target).equals(WEBM)).toBe(true);
	});

	it("does not follow a link put in its place", async () => {
		const victim = path.join(dir, "victim");
		writeFileSync(victim, "keep");
		const target = path.join(dir, "late.webm");
		symlinkSync(victim, target);
		expect(await writeVideo(target, WEBM)).toBe(false);
		expect(readFileSync(victim, "utf-8")).toBe("keep");
	});

	it("says so when the file cannot be opened", async () => {
		expect(await writeVideo(path.join(dir, "nowhere", "a.webm"), WEBM)).toBe(false);
	});
});

describe("REPLAY_EXPORT_VIDEO", () => {
	it("refuses a bad id or options before the backend is called", async () => {
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "../x", {})).toEqual({
			success: false,
			error: "Invalid session id",
		});
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", { stripTokens: "y" })).toEqual({
			success: false,
			error: "Invalid video options",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("records, asks where, and writes the WebM in the resolved folder", async () => {
		fetchMock.mockResolvedValueOnce(recorded());
		const chosen = path.join(dir, "demo");
		dialogs.save.mockResolvedValueOnce({ canceled: false, filePath: chosen });
		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {
			stripReasoning: true,
			language: "fr",
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/replay/sessions/s1/video");
		expect(JSON.parse(init.body)).toEqual({
			strip_reasoning: true,
			strip_tokens: false,
			language: "fr",
			format: "webm",
		});
		expect(dialogs.save.mock.calls[0][0].defaultPath).toBe("replay-coder.webm");
		expect(result).toMatchObject({ success: true, stepsPlayed: 3, stepsTotal: 5 });
		expect(String(result.filePath)).toMatch(/demo\.webm$/);
		expect(readFileSync(String(result.filePath)).equals(WEBM)).toBe(true);
	});

	it("a missing browser is an answer, an unknown refusal is not", async () => {
		fetchMock.mockResolvedValueOnce(
			answer({ success: true, available: false, refusal: "no_encoder" }),
		);
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {})).toEqual({
			success: true,
			refused: "no_encoder",
		});
		fetchMock.mockResolvedValueOnce(
			answer({ success: true, available: false, refusal: "rm -rf" }),
		);
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {})).toEqual({
			success: false,
			error: "bad_export",
		});
		expect(dialogs.save).not.toHaveBeenCalled();
	});

	it("refuses bytes that are not a WebM, before any dialog", async () => {
		fetchMock.mockResolvedValueOnce(
			recorded({ content_base64: Buffer.from("MZ").toString("base64") }),
		);
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {})).toEqual({
			success: false,
			error: "bad_export",
		});
		expect(dialogs.save).not.toHaveBeenCalled();
	});

	it("passes a backend failure on", async () => {
		fetchMock.mockResolvedValueOnce(answer({ detail: "video_timeout" }, 422));
		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {});
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("video_timeout");
	});

	it("writes nothing when the dialog is closed or the place is refused", async () => {
		fetchMock.mockResolvedValueOnce(recorded());
		dialogs.save.mockResolvedValueOnce({ canceled: true });
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {})).toEqual({
			success: true,
			canceled: true,
		});
		fetchMock.mockResolvedValueOnce(recorded({ file_name: undefined, steps_played: -1 }));
		mkdirSync(path.join(dir, "taken.webm"));
		dialogs.save.mockResolvedValueOnce({
			canceled: false,
			filePath: path.join(dir, "taken.webm"),
		});
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {})).toEqual({
			success: false,
			error: "bad_target",
		});
		expect(dialogs.save.mock.calls[1][0].defaultPath).toBe("replay.webm");
	});

	it("counts that are not counts become zero", async () => {
		fetchMock.mockResolvedValueOnce(recorded({ steps_played: 1.5, steps_total: "9" }));
		dialogs.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(dir, "c") });
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", {})).toMatchObject({
			stepsPlayed: 0,
			stepsTotal: 0,
		});
	});
});

describe("REPLAY_SUMMARIZE_SESSION", () => {
	it("asks the backend with the checked provider and language", async () => {
		fetchMock.mockResolvedValueOnce(answer({ success: true, summary: { text: "- ok" } }));
		const result = await call(IPC_CHANNELS.REPLAY_SUMMARIZE_SESSION, "s1", {
			provider: "openai",
			language: "fr",
		});
		expect(result).toEqual({ success: true, summary: { text: "- ok" } });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/replay/sessions/s1/summary");
		expect(JSON.parse(init.body)).toEqual({ provider: "openai", language: "fr" });
	});

	it("refuses a bad id or request before the backend is called", async () => {
		expect(await call(IPC_CHANNELS.REPLAY_SUMMARIZE_SESSION, "a/b", {})).toEqual({
			success: false,
			error: "Invalid session id",
		});
		expect(
			await call(IPC_CHANNELS.REPLAY_SUMMARIZE_SESSION, "s1", { provider: "$(x)" }),
		).toEqual({ success: false, error: "Invalid summary request" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
