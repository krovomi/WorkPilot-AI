/**
 * Server mode: the team room of a shown server board (`server-team-room.ts`).
 * The renderer passes a project id the app listed, a chat message, or a task
 * id; the room's updates go back to the window that joined, and stop when it
 * closes. The server decides who may write and who may release a claim.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { runOneShotLLM } from "../oneshot-llm";
import {
	joinTeamRoom,
	leaveTeamRoom,
	rejectInTeamRoom,
	releaseCardClaim,
	sendTeamChat,
	setTeamChatObserver,
} from "../server-team-room";
import { getAuthState } from "../server-connection";
import { getPageFeatureSettings } from "../services/page-llm-config";
import { TeamChatAi } from "../team-chat-ai";

const TEAM_AI_TIMEOUT_MS = 120_000;

/** `@ia` in my messages: answered by my app, with my Insights page's provider. */
function teamChatAi(): TeamChatAi {
	return new TeamChatAi({
		myId: () => getAuthState().user?.id ?? null,
		complete: (prompt, systemPrompt) => {
			const { provider, model } = getPageFeatureSettings("insights");
			return runOneShotLLM({
				prompt,
				systemPrompt,
				provider: provider || undefined,
				model: model || undefined,
				timeoutMs: TEAM_AI_TIMEOUT_MS,
				debugLabel: "TeamChatAI",
			});
		},
		send: (projectId, message, replyTo) => sendTeamChat(projectId, message, replyTo).success,
		onFailure: (projectId) => rejectInTeamRoom(projectId, "ai_unavailable"),
	});
}

export function registerTeamRoomHandlers(): void {
	setTeamChatObserver(teamChatAi());
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
