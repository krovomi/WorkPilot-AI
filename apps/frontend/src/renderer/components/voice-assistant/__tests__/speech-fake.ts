import { vi } from "vitest";

/** A stand-in for the Web Speech API's synthesis, which jsdom does not have. */
export interface FakeUtterance {
	text: string;
	lang: string;
	voice: unknown;
	onend: (() => void) | null;
	onerror: (() => void) | null;
}

export const LOCAL_VOICES = [
	{ name: "Amélie", lang: "fr-CA", localService: true, default: false },
	{ name: "Thomas", lang: "fr-FR", localService: true, default: true },
	{ name: "Samantha", lang: "en-US", localService: true, default: false },
];

export function installSpeech(voices: readonly object[] = LOCAL_VOICES) {
	const spoken: FakeUtterance[] = [];
	class Utterance implements FakeUtterance {
		lang = "";
		voice: unknown = null;
		onend: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor(public text: string) {}
	}
	const engine = {
		speak: vi.fn((utterance: FakeUtterance) => spoken.push(utterance)),
		cancel: vi.fn(),
		getVoices: vi.fn(() => voices),
	};
	Object.defineProperty(window, "speechSynthesis", { configurable: true, value: engine });
	Object.defineProperty(window, "SpeechSynthesisUtterance", {
		configurable: true,
		writable: true,
		value: Utterance,
	});
	return {
		engine,
		spoken,
		/** What was said, in order. */
		said: () => spoken.map((utterance) => utterance.text),
		uninstall: () => {
			Reflect.deleteProperty(window, "speechSynthesis");
			Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
		},
	};
}
