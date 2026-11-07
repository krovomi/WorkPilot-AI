import { useCallback, useEffect, useRef, useState } from "react";
import type { DictationResult } from "@shared/types/dictation";
import { captureDictation } from "../task-form/dictation-audio";

/**
 * One spoken command through the app's local dictation (faster-whisper, the
 * same session as the task form's « Dicter », `ipc-handlers/dictation-handlers.ts`).
 * Audio stays in memory; phrases are transcribed after each pause and the
 * sentence ends by itself after a silence, or when `finish` is called.
 */

export type CapturePhase = "idle" | "preparing" | "downloading" | "listening" | "finishing";

export const CAPTURE_ERRORS = [
	"model",
	"dependency",
	"offline",
	"download",
	"busy",
	"timeout",
	"transcription",
	"microphone",
] as const;
export type CaptureError = (typeof CAPTURE_ERRORS)[number];

/** Quiet after speech that ends the sentence. */
export const SILENCE_MS = 1600;
/** A command is short: past this, the sentence ends anyway. */
export const MAX_LISTEN_MS = 30_000;
/** `captureDictation`'s level for the RMS it treats as voice (0.008 × 8). */
const VOICE_LEVEL = 0.064;

interface Options {
	language: string;
	projectPath?: string;
	/** A transcribed phrase, in order. */
	onText: (text: string) => void;
	/** The sentence is over and every phrase has been transcribed. */
	onDone: () => void;
}

export function useVoiceCapture({ language, projectPath, onText, onDone }: Options) {
	const [phase, setPhase] = useState<CapturePhase>("idle");
	const [error, setError] = useState<CaptureError | null>(null);
	const [level, setLevel] = useState(0);
	const phaseRef = useRef<CapturePhase>("idle");
	const session = useRef<string | null>(null);
	const stopAudio = useRef<((discard?: boolean) => void) | null>(null);
	const queue = useRef<Promise<void>>(Promise.resolve());
	const spoke = useRef(false);
	const heardAt = useRef(0);
	const startedAt = useRef(0);
	// The latest callbacks, without restarting a session when they change.
	const handlers = useRef({ onText, onDone, language });
	handlers.current = { onText, onDone, language };

	const transition = useCallback((next: CapturePhase) => {
		phaseRef.current = next;
		setPhase(next);
	}, []);

	const cancel = useCallback(() => {
		const current = session.current;
		session.current = null;
		stopAudio.current?.(true);
		stopAudio.current = null;
		if (current)
			void window.electronAPI.dictationCancel(current).catch(() => {
				/* The renderer may be closing. */
			});
		transition("idle");
		setLevel(0);
	}, [transition]);

	const finish = useCallback(() => {
		if (phaseRef.current !== "listening") return;
		transition("finishing");
		stopAudio.current?.();
		stopAudio.current = null;
		setLevel(0);
		const current = session.current;
		void queue.current.finally(() => {
			if (!current || session.current !== current) return;
			cancel();
			handlers.current.onDone();
		});
	}, [cancel, transition]);

	const start = useCallback(
		async (download = false) => {
			if (phaseRef.current !== "idle") return;
			const current = crypto.randomUUID();
			session.current = current;
			setError(null);
			spoke.current = false;
			queue.current = Promise.resolve();
			transition(download ? "downloading" : "preparing");
			try {
				const ready = await window.electronAPI.dictationStart(current, download, projectPath);
				if (session.current !== current) return;
				if (ready.error || !ready.ready) throw new Error(ready.error || "transcription");
				if (download) {
					// The model is on disk now: listen right away.
					cancel();
					void start(false);
					return;
				}
				const stop = await captureDictation(
					(audio) => {
						if (session.current !== current) return;
						queue.current = queue.current.then(async () => {
							if (session.current !== current) return;
							const response = await window.electronAPI
								.dictationTranscribe(current, audio, handlers.current.language)
								.catch((): DictationResult => ({ error: "transcription" }));
							if (session.current !== current) return;
							if (response.error) {
								setError("transcription");
								cancel();
								return;
							}
							if (response.text) handlers.current.onText(response.text);
						});
					},
					(value) => {
						setLevel(value);
						if (value > VOICE_LEVEL) {
							spoke.current = true;
							heardAt.current = Date.now();
						}
					},
					finish,
				);
				if (session.current !== current) {
					stop(true);
					return;
				}
				stopAudio.current = stop;
				startedAt.current = Date.now();
				heardAt.current = Date.now();
				transition("listening");
			} catch (caught) {
				if (session.current !== current) return;
				const code = caught instanceof Error ? caught.message : "microphone";
				setError(
					(CAPTURE_ERRORS as readonly string[]).includes(code)
						? (code as CaptureError)
						: "microphone",
				);
				cancel();
			}
		},
		[cancel, finish, projectPath, transition],
	);

	// The sentence ends on a silence after speech, or after MAX_LISTEN_MS.
	useEffect(() => {
		if (phase !== "listening") return;
		const timer = setInterval(() => {
			const now = Date.now();
			if (
				(spoke.current && now - heardAt.current > SILENCE_MS) ||
				now - startedAt.current > MAX_LISTEN_MS
			)
				finish();
		}, 200);
		return () => clearInterval(timer);
	}, [phase, finish]);

	// Closing the panel (unmount) releases the microphone and the session.
	useEffect(() => cancel, [cancel]);

	return { phase, error, level, start, finish, cancel, clearError: () => setError(null) };
}
