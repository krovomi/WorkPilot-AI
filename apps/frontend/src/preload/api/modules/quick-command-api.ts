/**
 * The Kanban's quick-command bar: run a command on a review card (F181).
 */
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type { QuickCommandOutcome, QuickCommandRequest } from "../../../shared/types/quick-command";
import { invokeIpc } from "./ipc-utils";

export interface QuickCommandAPI {
	/** Runs the command in a review card's worktree; resolves when it is done. */
	runQuickCommand: (request: QuickCommandRequest) => Promise<IPCResult<QuickCommandOutcome>>;
}

export function createQuickCommandAPI(): QuickCommandAPI {
	return {
		runQuickCommand: (request) =>
			invokeIpc<IPCResult<QuickCommandOutcome>>(IPC_CHANNELS.QUICK_COMMAND_RUN, request),
	};
}
