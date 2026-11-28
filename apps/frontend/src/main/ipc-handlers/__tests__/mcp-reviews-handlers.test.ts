/**
 * The marketplace's review channels (#369, lot 5) hand the renderer's request,
 * untouched, to `main/mcp-reviews.ts`, which checks it.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const reviews = vi.hoisted(() => ({
	listMcpReviews: vi.fn(async () => ({ success: true, data: [] })),
	putMcpReview: vi.fn(async () => ({ success: false, error: "Invalid verdict" })),
	deleteMcpReview: vi.fn(async () => ({ success: true, data: true })),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		}),
	},
}));
vi.mock("../../mcp-reviews", () => reviews);

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerMcpReviewHandlers } from "../mcp-reviews-handlers";

beforeAll(() => {
	registerMcpReviewHandlers();
});

describe("MCP review channels", () => {
	it.each([
		[IPC_CHANNELS.MCP_MARKETPLACE_LIST_REVIEWS, reviews.listMcpReviews],
		[IPC_CHANNELS.MCP_MARKETPLACE_PUT_REVIEW, reviews.putMcpReview],
		[IPC_CHANNELS.MCP_MARKETPLACE_DELETE_REVIEW, reviews.deleteMcpReview],
	])("%s hands the request to its check", async (channel, check) => {
		const request = { projectId: "p-1", anything: "../x" };
		const answer = await handlers.get(channel)?.({}, request);
		expect(check).toHaveBeenCalledWith(request);
		expect(answer).toEqual(await check.mock.results[0]?.value);
	});
});
