/**
 * The bridge forwards the team review requests on their own channels, as
 * data (#369, lot 5).
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => ({ success: true }));
vi.mock("electron", () => ({
	ipcRenderer: { invoke: (...args: unknown[]) => invoke(...(args as [])) },
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createMcpAPI } from "../mcp-api";

describe("createMcpAPI reviews", () => {
	it("invokes the list, write and delete channels with the request", async () => {
		const api = createMcpAPI();
		const write = { projectId: "p1", serverId: "github", verdict: "safe", comment: "" } as const;
		await api.listMcpReviews({ projectId: "p1", serverId: "github" });
		await api.putMcpReview(write);
		await api.deleteMcpReview({ projectId: "p1", reviewId: "r1" });
		expect(invoke.mock.calls).toEqual([
			[IPC_CHANNELS.MCP_MARKETPLACE_LIST_REVIEWS, { projectId: "p1", serverId: "github" }],
			[IPC_CHANNELS.MCP_MARKETPLACE_PUT_REVIEW, write],
			[IPC_CHANNELS.MCP_MARKETPLACE_DELETE_REVIEW, { projectId: "p1", reviewId: "r1" }],
		]);
	});
});
