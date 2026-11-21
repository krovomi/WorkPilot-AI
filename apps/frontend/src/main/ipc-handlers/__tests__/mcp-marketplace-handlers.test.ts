/**
 * The marketplace's catalog, builder and Hugging Face channels: a builder file
 * that cannot be written is reported, and every refusal or failure is a code
 * the renderer words, never an English sentence. The builder's checks
 * themselves: mcp-builder-handlers.test.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-marketplace-handlers-"));
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const searchHuggingFaceModels = vi.fn();

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => userData) },
	ipcMain: {
		handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		}),
	},
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProject: () => undefined },
}));

vi.mock("../../services/hf-mcp-client", () => ({
	searchHuggingFaceModels: (...args: unknown[]) => searchHuggingFaceModels(...args),
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { loadMcpCatalog } from "../../../shared/mcp-catalog/install";
import { isMcpMarketplaceFailure } from "../../../shared/types/mcp-marketplace";
import { registerMcpMarketplaceHandlers } from "../mcp-marketplace-handlers";

type Answer = { success: boolean; data?: unknown; error?: string };
const call = (channel: string, ...args: unknown[]) =>
	handlers.get(channel)?.({}, ...args) as Promise<Answer>;

const dataDir = path.join(userData, "mcp-marketplace");
const builderFile = path.join(dataDir, "builder-projects.json");
const project = (id: string) => ({
	id,
	name: id,
	description: "",
	icon: "Wrench",
	color: "#000000",
	envVars: [],
	tools: [],
	createdAt: "2026-11-21T08:00:00.000Z",
	updatedAt: "2026-11-21T08:00:00.000Z",
});

beforeAll(() => {
	registerMcpMarketplaceHandlers();
});

beforeEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
	searchHuggingFaceModels.mockReset();
});

afterAll(() => {
	fs.rmSync(userData, { recursive: true, force: true });
});

describe("the catalog", () => {
	it("serves the shipped catalog", async () => {
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_CATALOG)).toEqual({
			success: true,
			data: loadMcpCatalog(),
		});
	});
});

describe("the builder projects", () => {
	it("says a save or a delete failed when the file cannot be written, as a code", async () => {
		// A folder where the file should be: reading gives nothing, writing throws.
		fs.mkdirSync(builderFile, { recursive: true });
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const save = await call(IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER, project("a1"));
		expect(save).toEqual({ success: false, error: "builderSaveFailed" });
		const remove = await call(IPC_CHANNELS.MCP_MARKETPLACE_DELETE_BUILDER, { projectId: "a1" });
		expect(remove).toEqual({ success: false, error: "builderDeleteFailed" });
		const invalid = await call(IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER, { id: "../a" });
		expect(invalid).toEqual({ success: false, error: "invalidBuilderRequest" });
		expect([save.error, remove.error, invalid.error].every(isMcpMarketplaceFailure)).toBe(true);
		expect(isMcpMarketplaceFailure("Save failed")).toBe(false);
	});
});

describe("the Hugging Face search", () => {
	it("passes the search on, with no parameters as none", async () => {
		searchHuggingFaceModels.mockResolvedValue({ success: true, data: [] });
		await call(IPC_CHANNELS.HUGGINGFACE_SEARCH_MODELS, { query: "llama" });
		await call(IPC_CHANNELS.HUGGINGFACE_SEARCH_MODELS, undefined);
		expect(searchHuggingFaceModels.mock.calls).toEqual([[{ query: "llama" }], [{}]]);
	});
});
