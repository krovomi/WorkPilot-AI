/**
 * From a spoken sentence to what the assistant does: the panel
 * (`VoiceAssistant.tsx`) and the continuous mode (`VoiceContinuous.tsx`) read a
 * sentence the same way.
 *
 * 1. A spoken « stop » first (`voice-stop.ts`): never a model's call.
 * 2. The local reading (`voice-intent.ts`) when it is sure.
 * 3. The feature model otherwise, then the unsure local reading as a fallback.
 */

import type { StopAfterStepResult } from "@shared/types";
import type { VoiceDestination, VoiceIntent } from "@shared/types/voice-assistant";
import { readVoiceCommand } from "./voice-intent";
import { readStopCommand } from "./voice-stop";

export type VoiceOutcome =
	| { kind: "intent"; intent: VoiceIntent }
	| { kind: "stop" }
	| { kind: "message"; key: string; text?: string };

export async function resolveSentence(
	said: string,
	offered: readonly VoiceDestination[],
	language: string,
	projectId: string | undefined,
	onThinking: () => void,
): Promise<VoiceOutcome> {
	const sentence = said.trim();
	if (!sentence) return { kind: "message", key: "results.nothingHeard" };
	if (readStopCommand(sentence)) return { kind: "stop" };
	const local = readVoiceCommand(sentence, offered);
	if (local.confident) return { kind: "intent", intent: local.intent };
	onThinking();
	const answer = await window.electronAPI
		.interpretVoiceCommand(sentence, [...offered], language, projectId)
		.catch(() => ({ success: false as const, error: "unavailable" as const }));
	if (answer.success) return { kind: "intent", intent: answer.intent };
	if (local.intent.kind !== "unknown") return { kind: "intent", intent: local.intent };
	return {
		kind: "message",
		key: answer.error === "unavailable" ? "results.noModel" : "results.unknown",
		text: sentence,
	};
}

/** The spoken stop, once confirmed: the i18n key (under `voiceAssistant:`) and its count. */
export async function stopAgentsAfterStep(): Promise<{ key: string; count: number }> {
	const result = await window.electronAPI
		.stopAgentsAfterStep()
		.catch((): { success: false } => ({ success: false }));
	if (!result.success || !result.data) return { key: "stop.failed", count: 0 };
	const data: StopAfterStepResult = result.data;
	if (data.failedTasks.length > 0) return { key: "stop.failed", count: data.failedTasks.length };
	if (data.stoppingTasks.length === 0) return { key: "stop.none", count: 0 };
	return { key: "stop.stopping", count: data.stoppingTasks.length };
}
