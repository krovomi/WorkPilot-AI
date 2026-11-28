import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { installSpeech } from "../../voice-assistant/__tests__/speech-fake";

let speech: ReturnType<typeof installSpeech>;
import { VoiceAssistantSettings } from "../VoiceAssistantSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values?.shortcut ? `${key}:${String(values.shortcut)}` : key,
		i18n: { language: "fr" },
	}),
}));

const base = {} as AppSettings;

describe("VoiceAssistantSettings", () => {
	beforeEach(() => {
		speech = installSpeech();
		Object.assign(window.electronAPI, {
			getVoiceShortcutStatus: vi.fn().mockResolvedValue("off"),
		});
	});

	it("shows the default and records a free combination", () => {
		const change = vi.fn();
		render(<VoiceAssistantSettings settings={base} onSettingsChange={change} />);
		expect(screen.getByText("Ctrl+Shift+Space")).toBeInTheDocument();
		const recorder = screen.getByText("settings.change");
		fireEvent.click(recorder);
		fireEvent.keyDown(recorder, { key: "Shift", code: "ShiftLeft", shiftKey: true });
		fireEvent.keyDown(recorder, { key: "V", code: "KeyV", altKey: true, shiftKey: true });
		expect(change).toHaveBeenCalledWith({ voiceAssistantShortcut: "Alt+Shift+V" });
	});

	it("refuses a shortcut WorkPilot already uses, and AltGr", () => {
		const change = vi.fn();
		render(<VoiceAssistantSettings settings={base} onSettingsChange={change} />);
		const recorder = screen.getByText("settings.change");
		fireEvent.click(recorder);
		fireEvent.keyDown(recorder, { key: "k", code: "KeyK", ctrlKey: true });
		expect(screen.getByRole("alert")).toHaveTextContent("settings.conflict.used:Ctrl+K");
		fireEvent.keyDown(recorder, { key: "v", code: "KeyV", ctrlKey: true, altKey: true });
		expect(screen.getByRole("alert")).toHaveTextContent("settings.conflict.altgr");
		expect(change).not.toHaveBeenCalled();
	});

	it("restores the default and switches the system-wide registration", () => {
		const change = vi.fn();
		render(
			<VoiceAssistantSettings
				settings={{ ...base, voiceAssistantShortcut: "Alt+Shift+V" }}
				onSettingsChange={change}
			/>,
		);
		fireEvent.click(screen.getByText("settings.reset"));
		expect(change).toHaveBeenCalledWith({ voiceAssistantShortcut: "CommandOrControl+Shift+Space" });
		fireEvent.click(screen.getByRole("switch", { name: "settings.systemWide" }));
		expect(change).toHaveBeenLastCalledWith({
			voiceAssistantShortcut: "Alt+Shift+V",
			voiceAssistantSystemWide: true,
		});
	});

	it("chooses the microphone sensitivity, medium by default", () => {
		const change = vi.fn();
		render(<VoiceAssistantSettings settings={base} onSettingsChange={change} />);
		const select = screen.getByLabelText("settings.sensitivity");
		expect(select).toHaveValue("medium");
		expect(screen.getByText("settings.sensitivityLevels.low")).toBeInTheDocument();
		fireEvent.change(select, { target: { value: "low" } });
		expect(change).toHaveBeenCalledWith({ voiceAssistantSensitivity: "low" });
	});
	it("chooses the spoken feedback, off by default, and plays a sample", () => {
		const change = vi.fn();
		const view = render(<VoiceAssistantSettings settings={base} onSettingsChange={change} />);
		const select = screen.getByLabelText("settings.feedback");
		expect(select).toHaveValue("off");
		expect(screen.getByText("settings.feedbackTry").closest("button")).toBeDisabled();
		fireEvent.change(select, { target: { value: "verbose" } });
		expect(change).toHaveBeenCalledWith({ voiceAssistantFeedback: "verbose" });
		view.rerender(
			<VoiceAssistantSettings settings={{ ...base, voiceAssistantFeedback: "short" }} onSettingsChange={change} />,
		);
		fireEvent.click(screen.getByText("settings.feedbackTry"));
		expect(speech.said()).toEqual(["settings.feedbackSample"]);
		expect(speech.spoken[0].lang).toBe("fr");
		speech.spoken[0].onend?.();
		expect(screen.queryByText("settings.feedbackUnavailable")).toBeNull();
	});

	it("says when this system has no local voice", () => {
		speech.uninstall();
		render(<VoiceAssistantSettings settings={base} onSettingsChange={vi.fn()} />);
		expect(screen.getByText("settings.feedbackUnavailable")).toBeInTheDocument();
	});

	it("turns the wake word on, then names its phrase", () => {
		const change = vi.fn();
		const view = render(<VoiceAssistantSettings settings={base} onSettingsChange={change} />);
		expect(screen.queryByLabelText("settings.wakePhrase")).toBeNull();
		fireEvent.click(screen.getByRole("switch", { name: "settings.wake" }));
		expect(change).toHaveBeenCalledWith({ voiceAssistantWakeWord: true });
		view.rerender(
			<VoiceAssistantSettings settings={{ ...base, voiceAssistantWakeWord: true }} onSettingsChange={change} />,
		);
		const phrase = screen.getByLabelText("settings.wakePhrase");
		expect(phrase).toHaveValue("Hey WorkPilot");
		fireEvent.change(phrase, { target: { value: "Hey Otto" } });
		expect(change).toHaveBeenLastCalledWith({ voiceAssistantWakeWord: true, voiceAssistantWakePhrase: "Hey Otto" });
		view.rerender(
			<VoiceAssistantSettings
				settings={{ ...base, voiceAssistantWakeWord: true, voiceAssistantWakePhrase: "Hey Otto" }}
				onSettingsChange={change}
			/>,
		);
		expect(screen.getByLabelText("settings.wakePhrase")).toHaveValue("Hey Otto");
	});
});
