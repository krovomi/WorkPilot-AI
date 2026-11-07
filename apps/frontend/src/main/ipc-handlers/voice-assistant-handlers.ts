import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { VoiceInterpretResult } from "../../shared/types/voice-assistant";
import { runOneShotLLM } from "../oneshot-llm";
import { projectStore } from "../project-store";
import { getServerProject } from "../server-projects";
import { getPageFeatureSettings } from "../services/page-llm-config";
import {
	getVoiceGlobalShortcutState,
	syncVoiceGlobalShortcut,
} from "../voice-assistant/global-shortcut";
import {
	buildInterpretPrompt,
	parseInterpretAnswer,
	parseInterpretRequest,
	VOICE_SYSTEM_PROMPT,
} from "../voice-assistant/interpret";

/** A spoken command is short: past this, the model is not answering. */
const INTERPRET_TIMEOUT_MS = 45_000;

export function registerVoiceAssistantHandlers(
	getWindow: () => BrowserWindow | null,
): void {
	ipcMain.handle(
		IPC_CHANNELS.VOICE_ASSISTANT_INTERPRET,
		async (
			_event,
			transcript: unknown,
			destinations: unknown,
			language: unknown,
			projectId: unknown,
		): Promise<VoiceInterpretResult> => {
			const request = parseInterpretRequest(transcript, destinations, language);
			if (!request) return { success: false, error: "request" };
			// A local project gives the runner its provider routing; a server
			// project's folder is the app's mirror, not where the model runs.
			const projectDir =
				typeof projectId === "string" && !getServerProject(projectId)
					? projectStore.getProject(projectId)?.path
					: undefined;
			const { provider, model } = getPageFeatureSettings("voice-control");
			const answer = await runOneShotLLM({
				prompt: buildInterpretPrompt(request),
				systemPrompt: VOICE_SYSTEM_PROMPT,
				provider: provider || undefined,
				model: model || undefined,
				projectDir,
				timeoutMs: INTERPRET_TIMEOUT_MS,
				debugLabel: "VoiceAssistant",
			});
			if (!answer) return { success: false, error: "unavailable" };
			const intent = parseInterpretAnswer(answer, request);
			return intent ? { success: true, intent } : { success: false, error: "unparsable" };
		},
	);

	ipcMain.handle(IPC_CHANNELS.VOICE_ASSISTANT_SHORTCUT_STATUS, () =>
		getVoiceGlobalShortcutState(),
	);

	syncVoiceGlobalShortcut(getWindow);
}
