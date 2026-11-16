/**
 * The bridge forwards a security request on its own channel, as data (#369).
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => ({ success: true }));
vi.mock("electron", () => ({
	ipcRenderer: { invoke: (...args: unknown[]) => invoke(...(args as [])) },
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createMcpAPI } from "../mcp-api";

describe("createMcpAPI", () => {
	it("invokes mcpMarketplace:getSecurity with the request", async () => {
		const request = { serverId: "github", projectId: "p1", refresh: true };
		await createMcpAPI().getMcpServerSecurity(request);
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.MCP_MARKETPLACE_GET_SECURITY, request);
	});
});
