import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { VoiceAssistantSettings } from "../VoiceAssistantSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values?.shortcut ? `${key}:${String(values.shortcut)}` : key,
	}),
}));

const base = {} as AppSettings;

describe("VoiceAssistantSettings", () => {
	beforeEach(() => {
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
		fireEvent.click(screen.getByRole("switch"));
		expect(change).toHaveBeenLastCalledWith({
			voiceAssistantShortcut: "Alt+Shift+V",
			voiceAssistantSystemWide: true,
		});
	});
});
