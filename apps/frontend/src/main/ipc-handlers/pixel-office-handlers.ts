/**
 * Pixel Office: a mini-scene written by the model the person chose for the
 * page (`pageLlmOverrides["pixel-office"]`, else the utility model of the
 * provider in Settings), on any provider `runOneShotLLM` reaches. The request
 * is checked again here (`parseNarrativeRequest`); a refusal, a failure or an
 * empty answer is `{ success: false }`, and the office keeps its template.
 * On a server project, the team leaderboard and the person's consent to show
 * on it (`server-pixel-office.ts`).
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { NarrativeResult } from "../../shared/types/pixel-office";
import { runOneShotLLM } from "../oneshot-llm";
import {
	buildNarrativePrompt,
	NARRATIVE_SYSTEM_PROMPT,
	narrativeText,
	parseNarrativeRequest,
} from "../pixel-office-narrator";
import { getTeamBoard, setTeamConsent } from "../server-pixel-office";
import { getPageFeatureSettings } from "../services/page-llm-config";

/** A scene that arrives later than this is no longer the latest one. */
export const NARRATIVE_TIMEOUT_MS = 30_000;

export async function narrate(raw: unknown): Promise<NarrativeResult> {
	const request = parseNarrativeRequest(raw);
	if (!request) return { success: false };
	const { provider, model } = getPageFeatureSettings("pixel-office");
	const answer = await runOneShotLLM({
		prompt: buildNarrativePrompt(request),
		systemPrompt: NARRATIVE_SYSTEM_PROMPT,
		provider: provider || undefined,
		model: model || undefined,
		timeoutMs: NARRATIVE_TIMEOUT_MS,
		debugLabel: "PixelOfficeNarrative",
	});
	const text = narrativeText(answer);
	return text ? { success: true, text } : { success: false };
}

export function registerPixelOfficeHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.PIXEL_OFFICE_NARRATE, (_event, request: unknown) =>
		narrate(request),
	);
	ipcMain.handle(
		IPC_CHANNELS.PIXEL_OFFICE_TEAM_BOARD,
		(_event, projectId: unknown, request: unknown) => getTeamBoard(projectId, request),
	);
	ipcMain.handle(
		IPC_CHANNELS.PIXEL_OFFICE_TEAM_CONSENT,
		(_event, projectId: unknown, visible: unknown) => setTeamConsent(projectId, visible),
	);
}
