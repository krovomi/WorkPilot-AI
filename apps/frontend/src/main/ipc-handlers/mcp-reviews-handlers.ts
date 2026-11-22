/**
 * The team's reviews of a catalogue MCP server (#369, lot 5): three channels
 * of the marketplace, for a server project. `main/mcp-reviews.ts` checks
 * every argument before it asks the server.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { deleteMcpReview, listMcpReviews, putMcpReview } from "../mcp-reviews";

export function registerMcpReviewHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_LIST_REVIEWS, (_event, request: unknown) =>
		listMcpReviews(request),
	);
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_PUT_REVIEW, (_event, request: unknown) =>
		putMcpReview(request),
	);
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_DELETE_REVIEW, (_event, request: unknown) =>
		deleteMcpReview(request),
	);
}
