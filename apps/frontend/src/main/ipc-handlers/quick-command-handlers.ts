/**
 * The Kanban's quick-command bar: one command run on a review card
 * (`main/quick-command/quick-command-run.ts`, F181). The renderer names a
 * project by its id and a command by its name; both are checked again there.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { QuickCommandRequest } from "../../shared/types/quick-command";
import { runQuickCommand } from "../quick-command/quick-command-run";

export function registerQuickCommandHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.QUICK_COMMAND_RUN, (_event, request: QuickCommandRequest) =>
		runQuickCommand(request),
	);
}
