/**
 * The bridge forwards the policy and alert requests on their own channels, as
 * data (#369, lot 2).
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => ({ success: true }));
vi.mock("electron", () => ({
	ipcRenderer: { invoke: (...args: unknown[]) => invoke(...(args as [])) },
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createMcpAPI } from "../mcp-api";

describe("createMcpAPI", () => {
	it("invokes the policy, alerts and acknowledgement channels with the request", async () => {
		const api = createMcpAPI();
		await api.getMcpInstallPolicy({ projectId: "p1" });
		await api.getMcpInstalledWatch({ projectId: "p1" });
		await api.acknowledgeMcpAlerts({ serverId: "gitlab" });
		expect(invoke.mock.calls).toEqual([
			[IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, { projectId: "p1" }],
			[IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED_WATCH, { projectId: "p1" }],
			[IPC_CHANNELS.MCP_MARKETPLACE_ACKNOWLEDGE_ALERTS, { serverId: "gitlab" }],
		]);
	});
});
