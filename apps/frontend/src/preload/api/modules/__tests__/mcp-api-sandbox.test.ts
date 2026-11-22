/**
 * The bridge asks whether this machine starts a confined MCP server on its
 * own channel, as data (#369, lot 6).
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => ({ success: true }));
vi.mock("electron", () => ({
	ipcRenderer: { invoke: (...args: unknown[]) => invoke(...(args as [])) },
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createMcpAPI } from "../mcp-api";

describe("createMcpAPI sandbox", () => {
	it("invokes the sandbox channel with the request", async () => {
		const api = createMcpAPI();
		await api.getMcpSandboxStatus({ refresh: true });
		await api.getMcpSandboxStatus();
		expect(invoke.mock.calls).toEqual([
			[IPC_CHANNELS.MCP_MARKETPLACE_GET_SANDBOX, { refresh: true }],
			[IPC_CHANNELS.MCP_MARKETPLACE_GET_SANDBOX, undefined],
		]);
	});
});
