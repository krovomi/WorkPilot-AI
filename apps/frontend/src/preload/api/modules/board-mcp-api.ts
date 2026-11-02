/**
 * workpilot-board MCP server API — which AI apps start this project's board
 * server, and registering it with one (main/ipc-handlers/board-mcp-handlers.ts).
 *
 * The renderer names a project and a client; the main process builds the
 * command and finds every file itself.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	BoardMcpClientId,
	BoardMcpClientStatus,
	BoardMcpStatus,
	IPCResult,
} from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

export interface BoardMcpAPI {
	getBoardMcpStatus: (projectId: string) => Promise<IPCResult<BoardMcpStatus>>;
	/** Writes the entry (`add` true) or removes it (`add` false). */
	applyBoardMcp: (
		projectId: string,
		clientId: BoardMcpClientId,
		add: boolean,
	) => Promise<IPCResult<BoardMcpClientStatus>>;
}

export const createBoardMcpAPI = (): BoardMcpAPI => ({
	getBoardMcpStatus: (projectId) => invokeIpc(IPC_CHANNELS.BOARD_MCP_STATUS, projectId),
	applyBoardMcp: (projectId, clientId, add) =>
		invokeIpc(IPC_CHANNELS.BOARD_MCP_APPLY, projectId, clientId, add),
});
