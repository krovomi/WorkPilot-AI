import { useVoiceAssistantStore } from "../../stores/voice-assistant-store";

/**
 * The assistant's spoken feedback (issue #385): the system's own voices
 * through the Web Speech API (`speechSynthesis`), so nothing is installed,
 * no account is needed and the text never leaves the computer. A voice that
 * says it is not local is never used.
 *
 * - `off`: nothing is said (the default).
 * - `short`: the answer to each command (opened, created, stopped, a question).
 * - `verbose`: that, plus what the running tasks do (`voice-narration.ts`).
 *
 * While it speaks, the store's `speaking` is set so the microphones of the
 * continuous mode and the wake word ignore what they hear: the assistant does
 * not take its own voice for a command.
 */

export const VOICE_FEEDBACKS = ["off", "short", "verbose"] as const;
export type VoiceFeedback = (typeof VOICE_FEEDBACKS)[number];

/** A setting's value as a feedback level ("off" when absent or unknown). */
export function voiceFeedback(value: unknown): VoiceFeedback {
	return (VOICE_FEEDBACKS as readonly unknown[]).includes(value) ? (value as VoiceFeedback) : "off";
}

/** Whether a line said at this level is spoken with this setting. */
export function speaksAt(setting: VoiceFeedback, level: "short" | "verbose"): boolean {
	return setting === "verbose" || (setting === "short" && level === "short");
}

/** A spoken line stays short. */
export const MAX_SPOKEN = 300;
/** If the engine never says it finished, the microphones listen again after this. */
const SAFETY_MS = 20_000;

let speakingCount = 0;

function setSpeaking(delta: number) {
	speakingCount = Math.max(0, speakingCount + delta);
	useVoiceAssistantStore.setState({ speaking: speakingCount > 0 });
}

function synth(): SpeechSynthesis | null {
	if (typeof window.SpeechSynthesisUtterance !== "function") return null;
	return window.speechSynthesis ?? null;
}

/** Whether this system can speak at all (a local voice, or voices not listed yet). */
export function canSpeak(): boolean {
	const engine = synth();
	if (!engine) return false;
	const voices = engine.getVoices();
	return voices.length === 0 || voices.some((voice) => voice.localService);
}

/** The local voice for this language: the exact region first, then the language, then the default. */
export function pickVoice(
	voices: readonly SpeechSynthesisVoice[],
	language: string,
): SpeechSynthesisVoice | null {
	const local = voices.filter((voice) => voice.localService);
	const wanted = language.toLowerCase();
	const base = wanted.split("-")[0];
	return (
		local.find((voice) => voice.lang.toLowerCase() === wanted) ??
		local.find((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === base && voice.default) ??
		local.find((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === base) ??
		null
	);
}

/** Say a line in this language. False when nothing can be said. */
export function speak(text: string, language: string): boolean {
	const engine = synth();
	const line = text.replace(/\s+/g, " ").trim().slice(0, MAX_SPOKEN);
	if (!engine || !line) return false;
	const voices = engine.getVoices();
	// Listed voices that are all remote: say nothing rather than send the text out.
	if (voices.length > 0 && !voices.some((voice) => voice.localService)) return false;
	const utterance = new window.SpeechSynthesisUtterance(line);
	utterance.lang = language;
	const voice = pickVoice(voices, language);
	if (voice) utterance.voice = voice;
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		setSpeaking(-1);
	};
	const timer = setTimeout(finish, SAFETY_MS);
	utterance.onend = finish;
	utterance.onerror = finish;
	setSpeaking(1);
	engine.speak(utterance);
	return true;
}

/** Stop talking now (the microphone is muted, or the mode closed). */
export function stopSpeaking(): void {
	synth()?.cancel();
}

/** Say this line if the person's setting asks for this level. */
export function sayFeedback(
	setting: unknown,
	level: "short" | "verbose",
	text: string,
	language: string,
): boolean {
	return speaksAt(voiceFeedback(setting), level) ? speak(text, language) : false;
}
