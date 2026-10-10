/**
 * The plugin creator's "Open folder" button used to invoke `shell:openPath`,
 * a channel nothing handled: the click did nothing and said nothing. It now
 * goes through `pluginMarketplace:openLocalFolder`, which opens a folder only
 * when it lies under the creator's own `local/` directory.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-open-folder-"));
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const openPath = vi.fn(async (_target: string) => "");

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => userData) },
	ipcMain: {
		handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		}),
	},
	shell: { openPath: (target: string) => openPath(target) },
}));

import {
	registerPluginMarketplaceHandlers,
	resolveLocalPluginFolder,
} from "../plugin-marketplace-handlers";

const localRoot = path.join(userData, "plugin-marketplace", "local");
const plugin = path.join(localRoot, "my-plugin");
const outside = path.join(userData, "elsewhere");

beforeAll(() => {
	fs.mkdirSync(plugin, { recursive: true });
	fs.writeFileSync(path.join(plugin, "README.md"), "# my-plugin\n");
	fs.mkdirSync(outside, { recursive: true });
	registerPluginMarketplaceHandlers();
});

afterAll(() => {
	fs.rmSync(userData, { recursive: true, force: true });
});

beforeEach(() => {
	openPath.mockClear();
});

describe("resolveLocalPluginFolder", () => {
	it("accepts a plugin folder under local/", () => {
		expect(resolveLocalPluginFolder(plugin, localRoot)).toBe(
			fs.realpathSync(plugin),
		);
	});

	it.each([
		["the local/ root itself", localRoot],
		["a folder outside it", outside],
		["a path climbing out of it", path.join(plugin, "..", "..", "..", "elsewhere")],
		["a file, not a folder", path.join(plugin, "README.md")],
		["a folder that does not exist", path.join(localRoot, "missing")],
		["an empty string", ""],
		["a non-string", { path: plugin }],
	])("refuses %s", (_label, candidate) => {
		expect(resolveLocalPluginFolder(candidate, localRoot)).toBeNull();
	});

	it("refuses a link under local/ that leads outside it", () => {
		const link = path.join(localRoot, "escape");
		try {
			fs.symlinkSync(outside, link, "dir");
		} catch {
			return; // no symlink permission on this machine
		}
		expect(resolveLocalPluginFolder(link, localRoot)).toBeNull();
	});
});

describe("pluginMarketplace:openLocalFolder", () => {
	const invoke = (folder: unknown) =>
		handlers.get("pluginMarketplace:openLocalFolder")?.({}, folder);

	it("opens the folder the creator scaffolded", async () => {
		await expect(invoke(plugin)).resolves.toEqual({ success: true });
		expect(openPath).toHaveBeenCalledWith(fs.realpathSync(plugin));
	});

	it("never opens anything outside local/", async () => {
		const result = (await invoke(outside)) as { success: boolean };
		expect(result.success).toBe(false);
		expect(openPath).not.toHaveBeenCalled();
	});

	it("reports the shell's failure instead of swallowing it", async () => {
		openPath.mockResolvedValueOnce("No application to open folders");
		await expect(invoke(plugin)).resolves.toEqual({
			success: false,
			error: "No application to open folders",
		});
	});
});
