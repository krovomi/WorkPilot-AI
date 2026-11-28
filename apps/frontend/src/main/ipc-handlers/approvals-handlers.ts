/**
 * Settings, Approval tiers: whether Claude Ship was detected on a signed-in
 * Claude account (Team or Enterprise). Takes no argument from the renderer;
 * answers names and plans, never a token.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult } from "../../shared/types";
import type { ClaudeShipStatus } from "../../shared/types/approvals";
import { claudeShipStatus } from "../agent/approvals-env";
import { appLog } from "../app-logger";
import { startExpressLane } from "../express-lane";

export function getClaudeShipStatus(
	read: () => ClaudeShipStatus = () => claudeShipStatus(),
): IPCResult<ClaudeShipStatus> {
	try {
		return { success: true, data: read() };
	} catch (error) {
		appLog.warn("[Approvals] Claude Ship detection failed:", (error as Error).message);
		return { success: true, data: { detected: false, accounts: [] } };
	}
}

/** The page's one channel, and the express lane's timer (it stops itself at quit). */
export function registerApprovalsHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.APPROVALS_CLAUDE_SHIP_STATUS, () => getClaudeShipStatus());
	startExpressLane();
}
