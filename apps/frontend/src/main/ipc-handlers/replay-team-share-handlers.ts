/**
 * A replay left with a server project's team, behind a link that expires
 * (#347): share, list, revoke, open. Each argument is checked by
 * `../replay-team-share.ts` before anything is asked of the local backend or
 * the server.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	listTeamShares,
	openTeamShare,
	revokeTeamShare,
	shareToTeam,
} from "../replay-team-share";

export function registerReplayTeamShareHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.REPLAY_SHARE_TO_TEAM,
		(_e, sessionId: unknown, request: unknown) => shareToTeam(sessionId, request),
	);
	ipcMain.handle(IPC_CHANNELS.REPLAY_LIST_TEAM_SHARES, (_e, projectId: unknown) =>
		listTeamShares(projectId),
	);
	ipcMain.handle(
		IPC_CHANNELS.REPLAY_REVOKE_TEAM_SHARE,
		(_e, projectId: unknown, shareId: unknown) => revokeTeamShare(projectId, shareId),
	);
	ipcMain.handle(IPC_CHANNELS.REPLAY_OPEN_TEAM_SHARE, (_e, link: unknown) =>
		openTeamShare(link),
	);
}
