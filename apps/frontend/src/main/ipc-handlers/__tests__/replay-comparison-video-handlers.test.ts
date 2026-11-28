/**
 * A replay as an MP4, and two replays side by side as one video (#347).
 *
 * The renderer gives session ids, booleans, a language and a format from a
 * closed list. Main writes only a video of the format asked for, within the
 * bound, under its own extension, in the folder the person chose. Files are
 * real, in a temporary folder.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
	exportedVideo,
	registerReplayVideoHandlers,
	saveTarget,
	videoBody,
} from "../replay-video-handlers";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(8)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);
const fetchMock = vi.fn();
let dir = "";

const call = (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<Record<string, unknown>>;
};

const answer = (body: object) =>
	new Response(JSON.stringify({ success: true, ...body }), { status: 200 });

beforeEach(() => {
	handlers.clear();
	fetchMock.mockReset();
	dialogs.save.mockReset();
	dir = mkdtempSync(path.join(tmpdir(), "wp-replay-compare-"));
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

describe("the format", () => {
	it("is WebM unless MP4 is asked for, and nothing else", () => {
		expect(videoBody({ format: "mp4" })?.format).toBe("mp4");
		expect(videoBody({})?.format).toBe("webm");
		expect(videoBody({ format: "avi" })).toBeNull();
		expect(videoBody({ format: 4 })).toBeNull();
	});

	it("keeps only an MP4 when an MP4 was asked for", () => {
		expect(exportedVideo(MP4.toString("base64"), "mp4")?.equals(MP4)).toBe(true);
		expect(exportedVideo(WEBM.toString("base64"), "mp4")).toBeNull();
		expect(exportedVideo(MP4.toString("base64"), "webm")).toBeNull();
	});

	it("ends the file name in the format's extension", async () => {
		// The native realpath, as saveTarget uses: on Windows it expands an 8.3
		// short name of the temp folder (RUNNER~1), which realpathSync keeps.
		expect(await saveTarget(path.join(dir, "demo"), ".mp4")).toBe(
			path.join(realpathSync.native(dir), "demo.mp4"),
		);
		expect(await saveTarget(path.join(dir, "demo.webm"), ".mp4")).toMatch(/demo\.webm\.mp4$/);
	});
});

describe("REPLAY_EXPORT_VIDEO as an MP4", () => {
	it("writes the MP4 under its own extension", async () => {
		fetchMock.mockResolvedValueOnce(
			answer({
				available: true,
				file_name: "replay-coder.mp4",
				content_base64: MP4.toString("base64"),
				steps_played: 2,
				steps_total: 2,
			}),
		);
		dialogs.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(dir, "demo") });
		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", { format: "mp4" });
		expect(result).toMatchObject({ success: true, stepsPlayed: 2 });
		expect(String(result.filePath)).toMatch(/demo\.mp4$/);
		expect(readFileSync(String(result.filePath)).equals(MP4)).toBe(true);
		expect(dialogs.save.mock.calls[0][0].filters).toEqual([
			{ name: "MP4", extensions: ["mp4"] },
		]);
	});

	it("answers that this machine has no ffmpeg", async () => {
		fetchMock.mockResolvedValueOnce(answer({ available: false, refusal: "no_mp4_encoder" }));
		expect(await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", { format: "mp4" })).toEqual({
			success: true,
			refused: "no_mp4_encoder",
		});
	});

	it("names the file when the backend did not", async () => {
		fetchMock.mockResolvedValueOnce(
			answer({ available: true, content_base64: MP4.toString("base64") }),
		);
		dialogs.save.mockResolvedValueOnce({ canceled: true });
		await call(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, "s1", { format: "mp4" });
		expect(dialogs.save.mock.calls[0][0].defaultPath).toBe("replay.mp4");
	});
});

describe("REPLAY_EXPORT_COMPARISON_VIDEO", () => {
	it("records the two sessions side by side", async () => {
		fetchMock.mockResolvedValueOnce(
			answer({
				available: true,
				file_name: "replay-coder-compare.webm",
				content_base64: WEBM.toString("base64"),
				steps_played: 3,
				steps_total: 3,
			}),
		);
		dialogs.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(dir, "ab") });
		const result = await call(IPC_CHANNELS.REPLAY_EXPORT_COMPARISON_VIDEO, "a1", "b2", {
			stripTokens: true,
			language: "fr",
		});
		expect(result).toMatchObject({ success: true, stepsPlayed: 3, stepsTotal: 3 });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:9000/replay/compare/video");
		expect(JSON.parse(init.body)).toEqual({
			strip_reasoning: false,
			strip_tokens: true,
			language: "fr",
			format: "webm",
			session_a_id: "a1",
			session_b_id: "b2",
		});
	});

	it("refuses bad ids and options before asking", async () => {
		const channel = IPC_CHANNELS.REPLAY_EXPORT_COMPARISON_VIDEO;
		expect((await call(channel, "a/1", "b2", {})).error).toBe("Invalid session id");
		expect((await call(channel, "a1", 3, {})).error).toBe("Invalid session id");
		expect((await call(channel, "a1", "b2", { format: "gif" })).error).toBe(
			"Invalid video options",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
