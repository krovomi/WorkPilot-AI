import { useCallback, useEffect, useRef, useState } from "react";
import type { DictationResult } from "@shared/types/dictation";
import { holdVoiceMicrophone } from "../../stores/voice-assistant-store";
import { captureDictation, type DictationStop } from "../task-form/dictation-audio";
import { CAPTURE_ERRORS, type CaptureError, SILENCE_MS } from "./use-voice-capture";
import { createVoiceActivityDetector, type VoiceSensitivity } from "./voice-activity";

/**
 * The continuous mode's microphone: one dictation session (the same local
 * faster-whisper as the panel, `ipc-handlers/dictation-handlers.ts`) kept open
 * while the mode runs, so the model loads once, not once a sentence.
 *
 * The calibrated detector (`voice-activity.ts`) tells speech from the room. A
 * sentence ends on a silence after speech: the audio not sent yet is sent, and
 * once every phrase is transcribed the sentence goes to `onSentence`. What is
 * being transcribed shows as it comes (`partial`). `active: false` (muted, or
 * the panel open) turns the microphone and the session off; the task form's
 * dictation takes it at once (`claimMicrophoneForForm`). While `deaf` (the
 * assistant speaking), what the microphone hears is dropped, so the assistant
 * never takes its own voice for a command, and the session stays open.
 * With the language on « auto », `onSentence` gets the language Whisper heard.
 */

export type ContinuousPhase = "off" | "preparing" | "listening";

/** A sentence is short: past this much speech, it ends anyway. */
export const MAX_SENTENCE_MS = 30_000;
/** After the assistant spoke, the room's echo still counts as its voice for this long. */
export const ECHO_MS = 400;

interface Options {
	active: boolean;
	language: string;
	sensitivity?: VoiceSensitivity;
	projectPath?: string;
	deaf?: boolean;
	onSentence: (text: string, heardLanguage?: string) => void;
}

export function useContinuousCapture({
	active,
	language,
	sensitivity,
	projectPath,
	deaf = false,
	onSentence,
}: Options) {
	const [phase, setPhase] = useState<ContinuousPhase>("off");
	const [error, setError] = useState<CaptureError | null>(null);
	const [speaking, setSpeaking] = useState(false);
	const [partial, setPartial] = useState("");
	const session = useRef<string | null>(null);
	const stopAudio = useRef<DictationStop | null>(null);
	const queue = useRef<Promise<void>>(Promise.resolve());
	const phrases = useRef<string[]>([]);
	const heardLanguage = useRef<string | undefined>(undefined);
	const deafUntil = useRef(0);
	const release = useRef<(() => void) | null>(null);
	const spoke = useRef(false);
	const heardAt = useRef(0);
	const sentenceAt = useRef(0);
	const handlers = useRef({ onSentence, language });
	handlers.current = { onSentence, language };

	useEffect(() => {
		if (deaf) deafUntil.current = Number.POSITIVE_INFINITY;
		else if (deafUntil.current === Number.POSITIVE_INFINITY) deafUntil.current = Date.now() + ECHO_MS;
	}, [deaf]);

	const stopSession = useCallback(() => {
		const current = session.current;
		session.current = null;
		stopAudio.current?.(true);
		stopAudio.current = null;
		release.current?.();
		release.current = null;
		phrases.current = [];
		heardLanguage.current = undefined;
		spoke.current = false;
		setPartial("");
		setSpeaking(false);
		setPhase("off");
		if (current)
			void window.electronAPI.dictationCancel(current).catch(() => {
				/* The renderer may be closing. */
			});
	}, []);

	const fail = useCallback(
		(code: string) => {
			setError(
				(CAPTURE_ERRORS as readonly string[]).includes(code) ? (code as CaptureError) : "microphone",
			);
			stopSession();
		},
		[stopSession],
	);

	const start = useCallback(async () => {
		const current = crypto.randomUUID();
		session.current = current;
		queue.current = Promise.resolve();
		release.current?.();
		// Let go at once when the task form's dictation takes the microphone.
		release.current = holdVoiceMicrophone(stopSession);
		setPhase("preparing");
		try {
			const ready = await window.electronAPI.dictationStart(current, false, projectPath);
			if (session.current !== current) return;
			if (ready.error || !ready.ready) throw new Error(ready.error || "transcription");
			const stop = await captureDictation(
				(audio) => {
					if (Date.now() < deafUntil.current) return;
					queue.current = queue.current.then(async () => {
						if (session.current !== current) return;
						const response = await window.electronAPI
							.dictationTranscribe(current, audio, handlers.current.language)
							.catch((): DictationResult => ({ error: "transcription" }));
						if (session.current !== current) return;
						if (response.error) {
							fail("transcription");
							return;
						}
						if (response.text) {
							if (response.language) heardLanguage.current = response.language;
							phrases.current.push(response.text);
							setPartial(phrases.current.join(" "));
						}
					});
				},
				(_level, heard) => {
					const voiced = heard && Date.now() >= deafUntil.current;
					setSpeaking(voiced);
					if (!voiced) return;
					if (!spoke.current) sentenceAt.current = Date.now();
					spoke.current = true;
					heardAt.current = Date.now();
				},
				() => fail("microphone"),
				createVoiceActivityDetector(sensitivity).isVoice,
			);
			if (session.current !== current) {
				stop(true);
				return;
			}
			stopAudio.current = stop;
			setPhase("listening");
		} catch (caught) {
			if (session.current === current) fail(caught instanceof Error ? caught.message : "microphone");
		}
	}, [fail, projectPath, sensitivity, stopSession]);

	// On while active and not failed; a change of microphone settings starts again.
	useEffect(() => {
		if (!active || error) return;
		void start();
		return stopSession;
	}, [active, error, start, stopSession]);

	// A silence after speech, or a very long sentence, ends the sentence.
	useEffect(() => {
		if (phase !== "listening") return;
		const timer = setInterval(() => {
			const now = Date.now();
			if (
				!spoke.current ||
				(now - heardAt.current <= SILENCE_MS && now - sentenceAt.current <= MAX_SENTENCE_MS)
			)
				return;
			spoke.current = false;
			const current = session.current;
			stopAudio.current?.flush();
			void queue.current.then(() => {
				if (session.current !== current) return;
				const text = phrases.current.join(" ").trim();
				const spoken = heardLanguage.current;
				phrases.current = [];
				heardLanguage.current = undefined;
				setPartial("");
				if (text) handlers.current.onSentence(text, spoken);
			});
		}, 200);
		return () => clearInterval(timer);
	}, [phase]);

	return { phase, error, speaking, partial, clearError: () => setError(null) };
}
