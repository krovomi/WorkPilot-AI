/**
 * How replays are shared (#347), counted where they live: on this machine,
 * or by the server for one of its projects. The project id is checked by
 * `../replay-usage.ts` against the server projects the app listed.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { getReplayUsage, getTeamReplayUsage } from "../replay-usage";

export function registerReplayUsageHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.REPLAY_GET_USAGE, () => getReplayUsage());
	ipcMain.handle(IPC_CHANNELS.REPLAY_GET_TEAM_USAGE, (_e, projectId: unknown) =>
		getTeamReplayUsage(projectId),
	);
}
