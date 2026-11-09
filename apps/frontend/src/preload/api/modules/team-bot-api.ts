/**
 * Team Bot API — renderer-side bridge.
 *
 * Provider-agnostic: posts to Slack/Teams webhooks with structured events
 * sourced from the WorkPilot runtime (no LLM interaction). The main process
 * keeps the configuration: the renderer reads it with the webhook URL masked,
 * saves it, and asks for a send or a test, never handing over a URL to post to.
 */

import { invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	TeamBotConfig,
	TeamBotNotification,
} from "../../../shared/types/team-bot";

export type {
	TeamBotConfig,
	TeamBotEvent,
	TeamBotKind,
	TeamBotNotification,
	TeamBotSeverity,
} from "../../../shared/types/team-bot";

export interface TeamBotAPI {
	teamBotGetConfig: () => Promise<TeamBotConfig>;
	teamBotSaveConfig: (config: TeamBotConfig) => Promise<TeamBotConfig>;
	teamBotSend: (payload: TeamBotNotification) => Promise<{ ok: boolean }>;
	teamBotTest: () => Promise<{ ok: boolean }>;
}

export const createTeamBotAPI = (): TeamBotAPI => ({
	teamBotGetConfig: () => invokeIpc(IPC_CHANNELS.TEAM_BOT_GET_CONFIG),
	teamBotSaveConfig: (config) =>
		invokeIpc(IPC_CHANNELS.TEAM_BOT_SAVE_CONFIG, config),
	teamBotSend: (payload) => invokeIpc(IPC_CHANNELS.TEAM_BOT_SEND, { payload }),
	teamBotTest: () => invokeIpc(IPC_CHANNELS.TEAM_BOT_TEST),
});
