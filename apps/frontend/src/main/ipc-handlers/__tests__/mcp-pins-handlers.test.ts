/**
 * @vitest-environment node
 *
 * MCP tool pins over IPC: the renderer is not trusted, so a server id that is
 * not one `CUSTOM_MCP_SERVERS` could hold never reaches the backend, and the
 * confirmation of a suspicious approval is only ever a literal `true`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	fetch: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler),
	},
}));
vi.mock("../_backend-fetch", () => ({ backendFetch: state.fetch }));

import { IPC_CHANNELS } from "../../../shared/constants";
import { registerMcpPinsHandlers } from "../mcp-pins-handlers";

beforeEach(() => {
	state.handlers.clear();
	state.fetch.mockReset();
	registerMcpPinsHandlers();
});

const call = (channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args);

describe("mcp pins handlers", () => {
	it("lists the project's pins", async () => {
		state.fetch.mockResolvedValue({ success: true, servers: [{ serverId: "github" }] });
		const result = await call(IPC_CHANNELS.MCP_PINS_LIST, "/repo");
		expect(result).toEqual({ success: true, data: [{ serverId: "github" }] });
		expect(state.fetch.mock.calls[0][0]).toBe("/api/mcp-pins?project_dir=%2Frepo");
	});

	it.each([[""], ["../x"], ["a b"], [42], ["x".repeat(201)]])(
		"refuses the server id %j without asking the backend",
		async (serverId) => {
			const result = await call(IPC_CHANNELS.MCP_PINS_APPROVE, "/repo", serverId, true);
			expect(result).toEqual({ success: false, error: "Invalid server" });
			expect(state.fetch).not.toHaveBeenCalled();
		},
	);

	it("confirms a suspicious approval only on a literal true", async () => {
		state.fetch.mockResolvedValue({ success: false, error: "poisoned", suspicious: true });
		const result = await call(IPC_CHANNELS.MCP_PINS_APPROVE, "/repo", "github", "yes");
		const body = JSON.parse(state.fetch.mock.calls[0][1].body);
		expect(body).toEqual({
			project_dir: "/repo",
			server_id: "github",
			confirm_suspicious: false,
		});
		expect(result).toEqual({ success: false, error: "poisoned", suspicious: true });
	});
});
