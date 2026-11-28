/**
 * Pixel Office API — a mini-scene written by the page's model. The renderer
 * names the scene from closed lists; the main process checks it again and
 * builds the prompt itself. On a server project, the team leaderboard and
 * the person's choice to show by name on it.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	NarrativeRequest,
	NarrativeResult,
	TeamBoardRequest,
	TeamBoardResult,
	TeamConsentResult,
} from "../../../shared/types/pixel-office";
import { invokeIpc } from "./ipc-utils";

export interface PixelOfficeAPI {
	narrate: (request: NarrativeRequest) => Promise<NarrativeResult>;
	getTeamBoard: (projectId: string, request: TeamBoardRequest) => Promise<TeamBoardResult>;
	setTeamConsent: (projectId: string, visible: boolean) => Promise<TeamConsentResult>;
}

export const createPixelOfficeAPI = (): PixelOfficeAPI => ({
	narrate: (request) => invokeIpc(IPC_CHANNELS.PIXEL_OFFICE_NARRATE, request),
	getTeamBoard: (projectId, request) =>
		invokeIpc(IPC_CHANNELS.PIXEL_OFFICE_TEAM_BOARD, projectId, request),
	setTeamConsent: (projectId, visible) =>
		invokeIpc(IPC_CHANNELS.PIXEL_OFFICE_TEAM_CONSENT, projectId, visible),
});
