/**
 * The marketplace's policy and alert channels (#369, lot 2): the renderer
 * names a registered project or a catalog server id, checked here; the main
 * reads the policy and the project's servers from the project's own files.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	dir: "",
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	projects: new Map<string, { id: string; path: string }>(),
	start: vi.fn(),
	installed: [] as unknown[],
	error: vi.fn(),
	breakView: false,
}));

vi.mock("electron", () => ({
	app: { getPath: () => state.dir },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../../app-logger", () => ({ appLog: { error: state.error, warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../project-store", () => ({
	projectStore: { getProject: (id: string) => state.projects.get(id) },
}));
vi.mock("../../mcp-security/runtime", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../mcp-security/runtime")>();
	return {
		...real,
		startMcpInstalledWatch: () => state.start(),
		watchDeps: () => ({
			...real.watchDeps(),
			installed: () => {
				if (state.breakView) throw new Error("disk /secret/path");
				return state.installed;
			},
			offline: () => false,
		}),
	};
});

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { installedWatchStore } from "../../mcp-security/runtime";
import { registerMcpMarketplaceHandlers } from "../mcp-marketplace-handlers";

state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-watch-handler-"));
const project = path.join(state.dir, "project");

const call = (channel: string, request: unknown) =>
	state.handlers.get(channel)?.({}, request) as Promise<{
		success: boolean;
		data?: unknown;
		error?: string;
	}>;

let started = 0;

beforeAll(() => {
	fs.mkdirSync(project, { recursive: true });
	registerMcpMarketplaceHandlers();
	started = state.start.mock.calls.length;
});

beforeEach(() => {
	state.projects = new Map([["p1", { id: "p1", path: project }]]);
	state.installed = [];
	state.breakView = false;
	state.error.mockReset();
	fs.rmSync(path.join(project, ".workpilot"), { recursive: true, force: true });
});

afterAll(() => {
	fs.rmSync(state.dir, { recursive: true, force: true });
});

describe("registerMcpMarketplaceHandlers", () => {
	it("starts the daily check of installed servers", () => {
		expect(started).toBe(1);
	});
});

describe("builder projects", () => {
	it("keeps them in the marketplace's data folder", async () => {
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_BUILDER_PROJECTS, undefined)).toEqual({
			success: true,
			data: [],
		});
		await call(IPC_CHANNELS.MCP_MARKETPLACE_SAVE_BUILDER, {
			id: "b1",
			name: "B",
			description: "",
			icon: "server",
			color: "#000000",
			envVars: [],
			tools: [],
			createdAt: "2026-11-21T00:00:00Z",
			updatedAt: "2026-11-21T00:00:00Z",
		});
		expect(
			fs.existsSync(path.join(state.dir, "mcp-marketplace", "builder-projects.json")),
		).toBe(true);
	});
});

describe("mcpMarketplace:getPolicy", () => {
	it("reads the project's policy from its own folder", async () => {
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, { projectId: "p1" })).toEqual({
			success: true,
			data: { state: "none" },
		});
		fs.mkdirSync(path.join(project, ".workpilot"));
		fs.writeFileSync(path.join(project, ".workpilot", "mcp-policy.json"), '{"minScore": 70}');
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, { projectId: "p1" })).toEqual({
			success: true,
			data: { state: "active", policy: { minScore: 70, blockCustomServers: false } },
		});
	});

	it("refuses a request without a registered project, and a path in its place", async () => {
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, { projectId: "nope" })).toEqual({
			success: false,
			error: "watchUnknownProject",
		});
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, { projectPath: project })).toEqual({
			success: false,
			error: "watchProjectRequired",
		});
	});

	it("hides the detail of any other failure", async () => {
		state.projects = new Map([
			[
				"p1",
				{
					id: "p1",
					get path(): string {
						throw new Error("disk /secret/path");
					},
				},
			],
		]);
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, { projectId: "p1" })).toEqual({
			success: false,
			error: "policyReadFailed",
		});
		expect(state.error).toHaveBeenCalled();
	});
});

describe("mcpMarketplace:getInstalledWatch", () => {
	it("gives the status of the project's servers, as the main reads them", async () => {
		state.installed = [{ id: "mine", type: "command", command: "node" }];
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED_WATCH, { projectId: "p1" })).toEqual({
			success: true,
			data: { servers: [{ serverId: "mine", status: "unverifiable", alerts: [] }] },
		});
	});

	it("refuses an unknown project and hides any other failure", async () => {
		expect(
			(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED_WATCH, { projectId: "x" })).error,
		).toBe("watchUnknownProject");
		state.breakView = true;
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED_WATCH, { projectId: "p1" })).toEqual({
			success: false,
			error: "watchReadFailed",
		});
	});
});

describe("mcpMarketplace:acknowledgeAlerts", () => {
	it("acknowledges a server's alerts", async () => {
		installedWatchStore().write({
			servers: { gitlab: { alerts: [{ id: "a", kind: "deprecated", detectedAt: "x" }] } },
		});
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_ACKNOWLEDGE_ALERTS, { serverId: "gitlab" })).toEqual({
			success: true,
			data: true,
		});
		expect(installedWatchStore().read().servers.gitlab.alerts[0].acknowledgedAt).toBeDefined();
	});

	it("refuses a server id that is not one, and hides a write failure", async () => {
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_ACKNOWLEDGE_ALERTS, { serverId: "../x" })).toEqual({
			success: false,
			error: "watchServerRequired",
		});
		const store = installedWatchStore();
		const write = vi.spyOn(store, "write").mockImplementation(() => {
			throw new Error("EACCES /secret");
		});
		store.read = () => ({
			servers: { gitlab: { alerts: [{ id: "a", kind: "deprecated", detectedAt: "x" }] } },
		});
		expect(await call(IPC_CHANNELS.MCP_MARKETPLACE_ACKNOWLEDGE_ALERTS, { serverId: "gitlab" })).toEqual({
			success: false,
			error: "acknowledgeFailed",
		});
		write.mockRestore();
	});
});
