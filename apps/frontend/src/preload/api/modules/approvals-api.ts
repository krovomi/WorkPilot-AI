/** Settings, Approval tiers: what the main detected of Claude Ship. */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type { ClaudeShipStatus } from "../../../shared/types/approvals";
import { invokeIpc } from "./ipc-utils";

export interface ApprovalsAPI {
	getClaudeShipStatus: () => Promise<IPCResult<ClaudeShipStatus>>;
}

export const createApprovalsAPI = (): ApprovalsAPI => ({
	getClaudeShipStatus: () => invokeIpc(IPC_CHANNELS.APPROVALS_CLAUDE_SHIP_STATUS),
});
