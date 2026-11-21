/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import {
	canSpeak,
	MAX_SPOKEN,
	pickVoice,
	sayFeedback,
	speak,
	speaksAt,
	stopSpeaking,
	voiceFeedback,
} from "../voice-speech";
import { installSpeech, LOCAL_VOICES } from "./speech-fake";

const voice = (lang: string, localService = true, isDefault = false) =>
	({ name: lang, lang, localService, default: isDefault }) as SpeechSynthesisVoice;

describe("the feedback setting", () => {
	it("is off unless one of the known levels", () => {
		expect(voiceFeedback(undefined)).toBe("off");
		expect(voiceFeedback("loud")).toBe("off");
		expect(voiceFeedback("short")).toBe("short");
		expect(voiceFeedback("verbose")).toBe("verbose");
	});

	it("speaks the answers when short, and the tasks too when verbose", () => {
		expect(speaksAt("off", "short")).toBe(false);
		expect(speaksAt("short", "short")).toBe(true);
		expect(speaksAt("short", "verbose")).toBe(false);
		expect(speaksAt("verbose", "verbose")).toBe(true);
		expect(speaksAt("verbose", "short")).toBe(true);
	});
});

describe("choosing a voice", () => {
	it("takes the exact region, then the language's default, then the language, local only", () => {
		const voices = [voice("fr-FR", false), voice("fr-CA"), voice("fr_BE", true, true), voice("en-US")];
		expect(pickVoice(voices, "en-US")?.lang).toBe("en-US");
		expect(pickVoice(voices, "fr-FR")?.lang).toBe("fr_BE");
		expect(pickVoice([voice("fr-CA"), voice("de-DE")], "fr")?.lang).toBe("fr-CA");
		expect(pickVoice([voice("de-DE", false)], "de-DE")).toBeNull();
		expect(pickVoice([], "en")).toBeNull();
	});
});

describe("speaking", () => {
	let speech: ReturnType<typeof installSpeech>;
	beforeEach(() => {
		vi.useFakeTimers();
		useVoiceAssistantStore.setState({ speaking: false });
		speech = installSpeech();
	});
	afterEach(() => {
		// Finish whatever was left so the count starts again from nothing.
		for (const utterance of speech.spoken) utterance.onend?.();
		speech.uninstall();
		vi.useRealTimers();
	});

	it("says a line in the language asked, with a local voice, and marks the assistant speaking", () => {
		expect(speak("  Ouverture   du Kanban. ", "fr-FR")).toBe(true);
		const [utterance] = speech.spoken;
		expect(utterance.text).toBe("Ouverture du Kanban.");
		expect(utterance.lang).toBe("fr-FR");
		expect(utterance.voice).toBe(LOCAL_VOICES[1]);
		expect(useVoiceAssistantStore.getState().speaking).toBe(true);
		expect(speak("Second", "fr-FR")).toBe(true);
		utterance.onend?.();
		utterance.onend?.();
		expect(useVoiceAssistantStore.getState().speaking).toBe(true);
		speech.spoken[1].onerror?.();
		expect(useVoiceAssistantStore.getState().speaking).toBe(false);
		expect(speech.said()).toEqual(["Ouverture du Kanban.", "Second"]);
	});

	it("keeps a line short, says nothing for an empty one, and has no voice for an unknown language", () => {
		speak("a".repeat(MAX_SPOKEN + 50), "ja-JP");
		expect(speech.spoken[0].text).toHaveLength(MAX_SPOKEN);
		expect(speech.spoken[0].voice).toBeNull();
		expect(speak("   ", "fr")).toBe(false);
		expect(speech.spoken).toHaveLength(1);
	});

	it("listens again even when the engine never says it finished", () => {
		speak("Bonjour", "fr");
		expect(useVoiceAssistantStore.getState().speaking).toBe(true);
		vi.advanceTimersByTime(20_000);
		expect(useVoiceAssistantStore.getState().speaking).toBe(false);
	});

	it("never sends the text to a voice that is not on this computer", () => {
		speech.uninstall();
		speech = installSpeech([{ name: "Cloud", lang: "en-US", localService: false, default: true }]);
		expect(canSpeak()).toBe(false);
		expect(speak("Hello", "en-US")).toBe(false);
		expect(speech.engine.speak).not.toHaveBeenCalled();
	});

	it("speaks with the default voice while the list is still empty", () => {
		speech.uninstall();
		speech = installSpeech([]);
		expect(canSpeak()).toBe(true);
		expect(speak("Hello", "en-US")).toBe(true);
		expect(speech.spoken[0].voice).toBeNull();
	});

	it("stops talking on demand", () => {
		stopSpeaking();
		expect(speech.engine.cancel).toHaveBeenCalledOnce();
	});

	it("says feedback only at the level the setting asks for", () => {
		expect(sayFeedback("off", "short", "Fait", "fr")).toBe(false);
		expect(sayFeedback("short", "verbose", "Fait", "fr")).toBe(false);
		expect(sayFeedback("short", "short", "Fait", "fr")).toBe(true);
		expect(speech.said()).toEqual(["Fait"]);
	});
});

describe("without speech synthesis", () => {
	it("says nothing and stops nothing", () => {
		expect(canSpeak()).toBe(false);
		expect(speak("Hello", "en")).toBe(false);
		expect(() => stopSpeaking()).not.toThrow();
	});

	it("needs the utterance too, not only the engine", () => {
		Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { getVoices: () => [] } });
		expect(canSpeak()).toBe(false);
		Reflect.deleteProperty(window, "speechSynthesis");
	});

	it("needs the engine too, not only the utterance", () => {
		Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: class {} });
		expect(canSpeak()).toBe(false);
		Reflect.deleteProperty(window, "SpeechSynthesisUtterance");
	});
});
