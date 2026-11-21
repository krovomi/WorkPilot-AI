/**
 * Pixel Office API — a mini-scene written by the page's model. The renderer
 * names the scene from closed lists; the main process checks it again and
 * builds the prompt itself.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	NarrativeRequest,
	NarrativeResult,
} from "../../../shared/types/pixel-office";
import { invokeIpc } from "./ipc-utils";

export interface PixelOfficeAPI {
	narrate: (request: NarrativeRequest) => Promise<NarrativeResult>;
}

export const createPixelOfficeAPI = (): PixelOfficeAPI => ({
	narrate: (request) => invokeIpc(IPC_CHANNELS.PIXEL_OFFICE_NARRATE, request),
});
