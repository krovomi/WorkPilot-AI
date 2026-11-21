/**
 * @vitest-environment node
 *
 * The screenshot picker's two calls. The renderer is answered with a stable
 * code it translates, never an English sentence, and what the system said
 * stays in the log; the source id it sends is checked here.
 */
import { app, desktopCapturer, ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { SCREENSHOT_ERROR_CODES } from "../../../shared/types/screenshot";
import { registerScreenshotHandlers } from "../screenshot-handlers";

type MockIpcMain = typeof ipcMain & {
	invokeHandler(channel: string, event: unknown, ...args: unknown[]): Promise<unknown>;
};
const invoke = (channel: string, ...args: unknown[]) =>
	(ipcMain as MockIpcMain).invokeHandler(channel, {}, ...args);

const source = (id: string, name: string) => ({
	id,
	name,
	thumbnail: { toDataURL: () => `data:image/png;base64,${name}` },
});

let getSources: ReturnType<typeof vi.fn>;
const packaged = app as { isPackaged: boolean };

beforeEach(() => {
	packaged.isPackaged = true;
	getSources = vi
		.fn()
		.mockResolvedValue([source("screen:0:0", "Screen 1"), source("window:7:0", "Editor")]);
	(desktopCapturer as unknown as { getSources: typeof getSources }).getSources = getSources;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	registerScreenshotHandlers();
});

afterEach(() => {
	packaged.isPackaged = false;
	vi.restoreAllMocks();
});

describe("SCREENSHOT_GET_SOURCES", () => {
	it("lists screens and windows with a small preview", async () => {
		expect(await invoke(IPC_CHANNELS.SCREENSHOT_GET_SOURCES)).toEqual({
			success: true,
			data: [
				{ id: "screen:0:0", name: "Screen 1", thumbnail: "data:image/png;base64,Screen 1" },
				{ id: "window:7:0", name: "Editor", thumbnail: "data:image/png;base64,Editor" },
			],
		});
		expect(getSources).toHaveBeenCalledWith({
			types: ["screen", "window"],
			thumbnailSize: { width: 320, height: 240 },
		});
	});

	it("says a development build cannot capture, without asking the system", async () => {
		packaged.isPackaged = false;
		expect(await invoke(IPC_CHANNELS.SCREENSHOT_GET_SOURCES)).toEqual({
			success: false,
			devMode: true,
		});
		expect(getSources).not.toHaveBeenCalled();
	});

	it("answers a code when the system refuses, and logs what it said", async () => {
		getSources.mockRejectedValueOnce(new Error("Screen recording is not allowed"));
		expect(await invoke(IPC_CHANNELS.SCREENSHOT_GET_SOURCES)).toEqual({
			success: false,
			error: "sources_failed",
		});
		expect(console.error).toHaveBeenCalledWith(
			"Failed to get screenshot sources:",
			expect.objectContaining({ message: "Screen recording is not allowed" }),
		);
	});
});

describe("SCREENSHOT_CAPTURE", () => {
	it("captures the source picked at full resolution", async () => {
		expect(await invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, { sourceId: "window:7:0" })).toEqual({
			success: true,
			data: "data:image/png;base64,Editor",
		});
		expect(getSources).toHaveBeenCalledWith({
			types: ["screen", "window"],
			thumbnailSize: { width: 3840, height: 2160 },
		});
	});

	it.each([[undefined], [null], ["screen:0:0"], [{}], [{ sourceId: "" }], [{ sourceId: 7 }]])(
		"refuses what is not a source id (%j) before asking the system",
		async (options) => {
			expect(await invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, options)).toEqual({
				success: false,
				error: "invalid_source",
			});
			expect(getSources).not.toHaveBeenCalled();
		},
	);

	it("says the source is gone when the system no longer offers it", async () => {
		expect(await invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, { sourceId: "window:9:0" })).toEqual({
			success: false,
			error: "source_not_found",
		});
	});

	it.each([[new Error("GPU process lost")], ["odd"]])(
		"answers a code when the capture throws (%s)",
		async (thrown) => {
			getSources.mockRejectedValueOnce(thrown);
			const answer = await invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, { sourceId: "screen:0:0" });
			expect(answer).toEqual({ success: false, error: "capture_failed" });
			expect(console.error).toHaveBeenCalledWith("Failed to capture screenshot:", thrown);
		},
	);

	it("only ever answers a code the renderer knows", async () => {
		getSources.mockRejectedValue(new Error("x"));
		const answers = (await Promise.all([
			invoke(IPC_CHANNELS.SCREENSHOT_GET_SOURCES),
			invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, { sourceId: "screen:0:0" }),
			invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE, {}),
		])) as { error: string }[];
		for (const { error } of answers) expect(SCREENSHOT_ERROR_CODES).toContain(error);
	});
});
