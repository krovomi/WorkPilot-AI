import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import { captureDictation } from "../../task-form/dictation-audio";
import { VoiceWake } from "../VoiceWake";

vi.mock("../../task-form/dictation-audio", () => ({ captureDictation: vi.fn() }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values?.phrase ? `${key}:${String(values.phrase)}` : key,
		i18n: { language: "fr" },
	}),
}));

const tick = (ms = 0) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

describe("VoiceWake", () => {
	let chunk: (audio: ArrayBuffer) => void;
	let level: (value: number, voiced: boolean) => void;
	const stop = Object.assign(vi.fn(), { flush: vi.fn() });
	const dictationStart = vi.fn();
	const dictationTranscribe = vi.fn();
	const dictationCancel = vi.fn();

	const wake = (over: Record<string, unknown> = {}) =>
		useSettingsStore.setState((state) => ({
			settings: { ...state.settings, voiceAssistantWakeWord: true, voiceAssistantWakePhrase: undefined, ...over },
		}));

	const say = async (text: string) => {
		act(() => level(0.5, true));
		dictationTranscribe.mockResolvedValueOnce({ text });
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		await tick(2000);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		wake();
		useVoiceAssistantStore.setState({
			isOpen: false,
			continuous: false,
			speaking: false,
			formDictations: 0,
			pendingCommand: null,
		});
		useProjectStore.setState({
			activeProjectId: "p1",
			selectedProjectId: "p1",
			projects: [{ id: "p1", name: "Demo", path: "/repo" } as never],
		});
		dictationStart.mockResolvedValue({ ready: true });
		dictationCancel.mockResolvedValue(undefined);
		Object.assign(window.electronAPI, { dictationStart, dictationTranscribe, dictationCancel });
		vi.mocked(captureDictation).mockImplementation(async (onChunk, onLevel) => {
			chunk = onChunk;
			level = onLevel;
			return stop;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("is off unless the person turned it on, and while the continuous mode runs", async () => {
		wake({ voiceAssistantWakeWord: false });
		const { container, rerender } = render(<VoiceWake />);
		await tick();
		expect(container).toBeEmptyDOMElement();
		act(() => {
			wake();
			useVoiceAssistantStore.setState({ continuous: true });
		});
		rerender(<VoiceWake />);
		await tick();
		expect(container).toBeEmptyDOMElement();
		expect(dictationStart).not.toHaveBeenCalled();
	});

	it("waits for the phrase, shows the open microphone, and opens the panel on what followed", async () => {
		render(<VoiceWake />);
		await tick();
		expect(screen.getByRole("region")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:wake.waiting:Hey WorkPilot");
		await say("Ouvre le Kanban");
		expect(useVoiceAssistantStore.getState().isOpen).toBe(false);
		await say("Hey, Work Pilot, ouvre le Kanban.");
		expect(useVoiceAssistantStore.getState()).toMatchObject({ isOpen: true, pendingCommand: "ouvre le Kanban." });
		await tick();
		// The panel takes the microphone: the light goes away.
		expect(screen.queryByRole("region")).toBeNull();
		expect(dictationCancel).toHaveBeenCalled();
	});

	it("listens with the selected project when none is active", async () => {
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: "p1" });
		render(<VoiceWake />);
		await tick();
		expect(dictationStart).toHaveBeenCalledWith(expect.any(String), false, "/repo");
	});

	it("uses the person's phrase", async () => {
		wake({ voiceAssistantWakePhrase: "Hey Otto" });
		render(<VoiceWake />);
		await tick();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:wake.waiting:Hey Otto");
		await say("hey otto");
		expect(useVoiceAssistantStore.getState()).toMatchObject({ isOpen: true, pendingCommand: null });
	});

	it("mutes, gives way to the task form's dictation, and shows a failure with a retry", async () => {
		render(<VoiceWake />);
		await tick();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		await tick();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:wake.muted");
		expect(dictationCancel).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		expect(dictationStart).toHaveBeenCalledTimes(2);

		act(() => useVoiceAssistantStore.setState({ formDictations: 1 }));
		await tick();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.dictating");
		act(() => useVoiceAssistantStore.setState({ formDictations: 0 }));

		dictationStart.mockResolvedValueOnce({ error: "model" });
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:errors.model");
		fireEvent.click(screen.getByText("voiceAssistant:actions.retry"));
		await tick();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:wake.waiting:Hey WorkPilot");
	});

	it("ignores what it hears while the assistant speaks", async () => {
		render(<VoiceWake />);
		await tick();
		act(() => useVoiceAssistantStore.setState({ speaking: true }));
		act(() => level(0.5, true));
		act(() => chunk(new ArrayBuffer(44)));
		await tick(2000);
		expect(dictationTranscribe).not.toHaveBeenCalled();
	});
});
