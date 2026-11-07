/**
 * Server mode: the team room of a shown server board (`server-team-room.ts`).
 * The renderer passes a project id the app listed, a chat message, or a task
 * id; the room's updates go back to the window that joined, and stop when it
 * closes. The server decides who may write and who may release a claim.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	joinTeamRoom,
	leaveTeamRoom,
	releaseCardClaim,
	sendTeamChat,
} from "../server-team-room";

export function registerTeamRoomHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TEAM_ROOM_JOIN, (event, projectId: unknown) => {
		const sender = event.sender;
		const joined = joinTeamRoom(projectId, (update) => {
			if (sender.isDestroyed()) leaveTeamRoom(update.projectId);
			else sender.send(IPC_CHANNELS.TEAM_ROOM_UPDATE, update);
		});
		if (joined) sender.once("destroyed", () => leaveTeamRoom(projectId));
		return { success: joined };
	});
	ipcMain.handle(IPC_CHANNELS.TEAM_ROOM_LEAVE, (_e, projectId: unknown) => {
		leaveTeamRoom(projectId);
		return { success: true };
	});
	ipcMain.handle(
		IPC_CHANNELS.TEAM_CHAT_SEND,
		(_e, projectId: unknown, message: unknown, replyTo: unknown) =>
			sendTeamChat(projectId, message, replyTo),
	);
	ipcMain.handle(IPC_CHANNELS.TEAM_LOCK_RELEASE, (_e, taskId: unknown) =>
		releaseCardClaim(taskId),
	);
}
