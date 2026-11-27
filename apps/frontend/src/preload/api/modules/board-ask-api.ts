/**
 * « Interroger le tableau » API (main/ipc-handlers/board-ask-handlers.ts):
 * the renderer sends a project id, a question and the conversation so far;
 * the main process reads the tickets itself.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { BoardAskRequest, BoardAskResult, IPCResult } from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

export interface BoardAskAPI {
	askBoard: (request: BoardAskRequest) => Promise<IPCResult<BoardAskResult>>;
}

export const createBoardAskAPI = (): BoardAskAPI => ({
	askBoard: (request) => invokeIpc(IPC_CHANNELS.BOARD_ASK, request),
});
