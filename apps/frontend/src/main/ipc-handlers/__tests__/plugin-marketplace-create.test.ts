/**
 * `pluginMarketplace:create` turns the plugin id into a folder name under the
 * creator's `local/` directory, so the main process checks the id itself:
 * the wizard is not the only thing that can send a request.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-create-"));
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => userData) },
	ipcMain: {
		handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		}),
	},
	shell: { openPath: vi.fn(async () => "") },
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProject: vi.fn(() => undefined) },
}));

import {
	creatablePluginId,
	registerPluginMarketplaceHandlers,
} from "../plugin-marketplace-handlers";

const localRoot = path.join(userData, "plugin-marketplace", "local");

function request(id: unknown) {
	return {
		type: "spec-template",
		id,
		name: "My plugin",
		description: "Does a thing",
		version: "1.0.0",
	};
}

function create(payload: unknown) {
	const handler = handlers.get(IPC_CHANNELS.PLUGIN_MARKETPLACE_CREATE);
	if (!handler) throw new Error("create handler not registered");
	return handler({}, payload) as Promise<{ success: boolean; error?: string }>;
}

beforeAll(() => {
	registerPluginMarketplaceHandlers();
});

afterAll(() => {
	fs.rmSync(userData, { recursive: true, force: true });
});

describe("creatablePluginId", () => {
	it("accepts lowercase words joined by single hyphens", () => {
		expect(creatablePluginId({ id: "my-plugin-2" })).toBe("my-plugin-2");
	});

	it.each([
		["a parent folder", "../outside"],
		["a nested path", "a/b"],
		["a Windows separator", "a\\b"],
		["an absolute path", "/tmp/x"],
		["spaces", "my plugin"],
		["capitals", "MyPlugin"],
		["a leading hyphen", "-x"],
		["a double hyphen", "a--b"],
		["an empty id", ""],
		["an id that is too long", "a".repeat(65)],
		["a number", 7],
	])("refuses %s", (_label, id) => {
		expect(creatablePluginId({ id })).toBeNull();
	});

	it("refuses a request that is not an object", () => {
		expect(creatablePluginId(null)).toBeNull();
	});
});

describe("pluginMarketplace:create", () => {
	it("writes a plain id's plugin under local/", async () => {
		await expect(create(request("my-plugin"))).resolves.toEqual(
			expect.objectContaining({ success: true }),
		);
		expect(fs.existsSync(path.join(localRoot, "my-plugin", "plugin.config.json"))).toBe(true);
	});

	it("refuses an id that leaves local/, and writes nothing", async () => {
		await expect(create(request("../../escaped"))).resolves.toEqual({
			success: false,
			error: "Invalid plugin ID",
		});
		expect(fs.existsSync(path.join(userData, "escaped"))).toBe(false);
		expect(fs.existsSync(path.join(userData, "plugin-marketplace", "escaped"))).toBe(false);
	});
});
