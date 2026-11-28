/**
 * `dialog:selectFiles` passes the renderer's options to the native file
 * dialog. Only a text title, a text default path, a boolean `multi` and
 * well-formed filters reach it; anything else is left out.
 */
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const { registeredHandlers, mockHomeDir, showOpenDialog } = vi.hoisted(() => ({
	registeredHandlers: new Map<string, IpcHandler>(),
	mockHomeDir: require("node:os").tmpdir() as string,
	showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: IpcHandler) => {
			registeredHandlers.set(channel, handler);
		}),
	},
	app: {
		getPath: vi.fn(() => mockHomeDir),
		getAppPath: vi.fn(() => mockHomeDir),
	},
	dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
	shell: { openExternal: vi.fn() },
}));

vi.mock("@electron-toolkit/utils", () => ({ is: { dev: true } }));

vi.mock("../cli-tool-manager", () => ({
	configureTools: vi.fn(),
	getToolInfo: vi.fn(),
	isPathFromWrongPlatform: vi.fn(() => false),
	preWarmToolCache: vi.fn(),
}));

vi.mock("../settings-utils", () => ({
	readSettingsFile: vi.fn(() => ({})),
	writeSettingsFile: vi.fn(),
	getSettingsPath: vi.fn(() => join(mockHomeDir, "settings.json")),
}));

vi.mock("../agent", () => ({ AgentManager: vi.fn() }));

vi.mock("../app-updater", () => ({
	setUpdateChannel: vi.fn(),
	setUpdateChannelWithDowngradeCheck: vi.fn(() => Promise.resolve()),
}));

import { IPC_CHANNELS } from "../../shared/constants";
import {
	dialogFilters,
	registerSettingsHandlers,
} from "../ipc-handlers/settings-handlers";

const window = { id: 1 };
let selectFiles: IpcHandler;

beforeEach(() => {
	showOpenDialog.mockReset();
	showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
	registeredHandlers.clear();
	registerSettingsHandlers({} as never, () => window as never);
	const handler = registeredHandlers.get(IPC_CHANNELS.DIALOG_SELECT_FILES);
	if (!handler) throw new Error("dialog:selectFiles not registered");
	selectFiles = handler;
});

describe("dialogFilters", () => {
	it("keeps filters that each have a name and text extensions", () => {
		expect(dialogFilters([{ name: "Images", extensions: ["png", "jpg"] }])).toEqual([
			{ name: "Images", extensions: ["png", "jpg"] },
		]);
	});

	it.each([
		["no filters", undefined],
		["an empty list", []],
		["not a list", "png"],
		["a filter without a name", [{ extensions: ["png"] }]],
		["extensions that are not a list", [{ name: "x", extensions: "png" }]],
		["an extension that is not text", [{ name: "x", extensions: [1] }]],
		["a missing filter", [null]],
	])("gives no filter for %s", (_label, filters) => {
		expect(dialogFilters(filters)).toBeUndefined();
	});
});

describe("dialog:selectFiles", () => {
	it("passes well-formed options to the dialog", async () => {
		showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/picked/a.png"] });
		await expect(
			selectFiles({}, {
				title: "Pick",
				defaultPath: "/home",
				multi: true,
				filters: [{ name: "Images", extensions: ["png"] }],
			}),
		).resolves.toEqual(["/picked/a.png"]);
		expect(showOpenDialog).toHaveBeenCalledWith(window, {
			properties: ["openFile", "multiSelections"],
			title: "Pick",
			defaultPath: "/home",
			filters: [{ name: "Images", extensions: ["png"] }],
		});
	});

	it("leaves out options of the wrong type", async () => {
		await expect(
			selectFiles({}, {
				title: { toString: "x" },
				defaultPath: 42,
				multi: "yes",
				filters: [{ name: 1, extensions: ["png"] }],
			}),
		).resolves.toEqual([]);
		expect(showOpenDialog).toHaveBeenCalledWith(window, {
			properties: ["openFile"],
			title: "Select Files",
		});
	});
});
