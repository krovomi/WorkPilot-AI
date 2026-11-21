/**
 * The MCP Builder projects kept by the main: what the renderer sends is
 * checked field by field before it is written, and what is read back from
 * disk keeps only the projects that pass the same check.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-builder-handler-"));
const handlers = new Map<string, (...args: unknown[]) => unknown>();

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

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerMcpMarketplaceHandlers } from "../mcp-marketplace-handlers";

type Result = { success: boolean; data?: unknown; error?: string };
const call = (channel: string, ...args: unknown[]) =>
	handlers.get(channel)?.({}, ...args) as Promise<Result>;
const save = (project: unknown) => call(IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER, project);
const list = async () =>
	(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_BUILDER_PROJECTS)).data as Array<
		Record<string, unknown>
	>;
const file = () => path.join(userData, "mcp-marketplace", "builder-projects.json");

function project(overrides: Record<string, unknown> = {}) {
	return {
		id: "1700000000000-abc123",
		name: "Weather",
		description: "",
		icon: "Wrench",
		color: "#6366F1",
		baseUrl: "https://api.example.test",
		defaultHeaders: { Accept: "application/json" },
		envVars: [
			{ name: "API_KEY", label: "Key", description: "", required: true, secret: true },
		],
		tools: [
			{
				id: "1700000000001-def456",
				name: "get_forecast",
				description: "Forecast",
				parameters: [
					{ name: "city", type: "string", description: "", required: true },
				],
				action: {
					type: "http_request",
					http: { method: "GET", url: "{{baseUrl}}/forecast?q={{city}}" },
				},
			},
		],
		createdAt: "2026-11-21T08:00:00.000Z",
		updatedAt: "2026-11-21T08:00:00.000Z",
		...overrides,
	};
}

beforeAll(() => {
	registerMcpMarketplaceHandlers();
});

beforeEach(() => {
	fs.rmSync(file(), { force: true });
});

afterAll(() => {
	fs.rmSync(userData, { recursive: true, force: true });
});

describe("mcpMarketplace:saveBuilder", () => {
	it("keeps a project the builder makes, without fields it does not know", async () => {
		expect(await save({ ...project(), extra: "dropped" })).toEqual({ success: true });
		const [kept] = await list();
		expect(kept).toEqual(project());

		expect(await save(project({ name: "Weather 2" }))).toEqual({ success: true });
		expect((await list()).map((p) => p.name)).toEqual(["Weather 2"]);
	});

	it.each([
		["no object", null],
		["an id that is not a plain token", project({ id: "../../x" })],
		["a name past its limit", project({ name: "n".repeat(201) })],
		["an action of an unknown type", project({ tools: [{ ...project().tools[0], action: { type: "shell" } }] })],
		["too many tools", project({ tools: Array.from({ length: 101 }, () => project().tools[0]) })],
		["headers that are not text", project({ defaultHeaders: { Accept: 1 } })],
	])("refuses %s and writes nothing", async (_label, value) => {
		expect(await save(value)).toEqual({ success: false, error: "Invalid builder project" });
		expect(fs.existsSync(file())).toBe(false);
	});

	it("keeps at most 200 projects, and still updates one of them", async () => {
		const full = Array.from({ length: 200 }, (_, i) => project({ id: `p${i}` }));
		fs.writeFileSync(file(), JSON.stringify(full));
		expect(await save(project({ id: "p200" }))).toEqual({
			success: false,
			error: "Too many builder projects",
		});
		expect(await save(project({ id: "p7", name: "Updated" }))).toEqual({ success: true });
		expect((await list()).find((p) => p.id === "p7")?.name).toBe("Updated");
	});
});

describe("mcpMarketplace:getBuilderProjects", () => {
	it("reads back only the projects that pass the check", async () => {
		fs.writeFileSync(file(), JSON.stringify([project({ id: "ok" }), { id: "bad" }, 3]));
		expect((await list()).map((p) => p.id)).toEqual(["ok"]);
	});

	it("reads nothing from a file that is not a list", async () => {
		fs.writeFileSync(file(), JSON.stringify({ id: "x" }));
		expect(await list()).toEqual([]);
	});
});

describe("mcpMarketplace:deleteBuilder", () => {
	it("removes the project it names", async () => {
		await save(project({ id: "a" }));
		await save(project({ id: "b" }));
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_DELETE_BUILDER, { projectId: "a" })).toEqual({
			success: true,
		});
		expect((await list()).map((p) => p.id)).toEqual(["b"]);
	});

	it.each([[null], [{ projectId: 3 }], [{ projectId: "a/b" }]])(
		"refuses %j",
		async (request) => {
			expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_DELETE_BUILDER, request)).toEqual({
				success: false,
				error: "Invalid builder project",
			});
		},
	);
});
