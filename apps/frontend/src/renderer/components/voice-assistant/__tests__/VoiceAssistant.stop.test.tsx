import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../../../hooks/use-toast";
import { useProjectStore } from "../../../stores/project-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import { captureDictation } from "../../task-form/dictation-audio";
import { VoiceAssistant } from "../VoiceAssistant";

vi.mock("../../task-form/dictation-audio", () => ({ captureDictation: vi.fn() }));
vi.mock("../../../stores/task-store", async () => {
	const { create } = await import("zustand");
	return { createTask: vi.fn(), useTaskStore: create(() => ({ tasks: [] as unknown[] })) };
});
vi.mock("../../../hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values?.count !== undefined ? `${key}:${String(values.count)}` : key,
		i18n: { language: "fr" },
	}),
}));

const destinations = [{ id: "kanban", label: "Tableau Kanban" }];

describe("VoiceAssistant: the spoken stop and the continuous mode", () => {
	let chunk: (audio: ArrayBuffer) => void;
	let level: (value: number, voiced: boolean) => void;
	let isVoice: ((rms: number) => boolean) | undefined;
	const stop = Object.assign(vi.fn(), { flush: vi.fn() });
	const dictationStart = vi.fn();
	const dictationTranscribe = vi.fn();
	const dictationCancel = vi.fn();
	const stopAgentsAfterStep = vi.fn();

	const renderAssistant = () =>
		render(
			<VoiceAssistant
				destinations={destinations}
				onNavigate={vi.fn()}
				onNewTask={vi.fn()}
				onOpenSettings={vi.fn()}
			/>,
		);

	const openAndSay = async (text: string) => {
		renderAssistant();
		act(() => useVoiceAssistantStore.getState().press());
		await screen.findByText("voiceAssistant:phase.listening");
		dictationTranscribe.mockResolvedValueOnce({ text });
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.click(screen.getByLabelText("voiceAssistant:actions.stop"));
	};

	beforeEach(() => {
		vi.clearAllMocks();
		useVoiceAssistantStore.setState({ isOpen: false, continuous: false, pressCount: 0, lastPressAt: 0 });
		useSettingsStore.setState((state) => ({
			settings: { ...state.settings, voiceAssistantSensitivity: "low" },
		}));
		useProjectStore.setState({
			activeProjectId: "p1",
			selectedProjectId: "p1",
			projects: [{ id: "p1", name: "Demo", path: "/repo" } as never],
		});
		dictationStart.mockResolvedValue({ ready: true });
		dictationCancel.mockResolvedValue(undefined);
		Object.assign(window.electronAPI, {
			dictationStart,
			dictationTranscribe,
			dictationCancel,
			interpretVoiceCommand: vi.fn(),
			stopAgentsAfterStep,
		});
		vi.mocked(captureDictation).mockImplementation(async (onChunk, onLevel, _ended, detector) => {
			chunk = onChunk;
			level = onLevel;
			isVoice = detector;
			return stop;
		});
	});

	it.each([
		[{ stoppingTasks: ["t1"], failedTasks: [] }, "voiceAssistant:stop.stopping:1", "success"],
		[{ stoppingTasks: [], failedTasks: [] }, "voiceAssistant:stop.none:0", "default"],
		[{ stoppingTasks: [], failedTasks: ["t1"] }, "voiceAssistant:stop.failed:1", "destructive"],
	])("asks before a spoken stop, then stops the agents after their step (%#)", async (data, title, variant) => {
		stopAgentsAfterStep.mockResolvedValue({ success: true, data });
		await openAndSay("Stop");
		expect(await screen.findByText("voiceAssistant:stop.confirm")).toBeInTheDocument();
		expect(stopAgentsAfterStep).not.toHaveBeenCalled();
		// The shortcut does not start listening over the question.
		const sessions = dictationStart.mock.calls.length;
		act(() => useVoiceAssistantStore.getState().press());
		act(() => useVoiceAssistantStore.setState({ lastPressAt: 0 }));
		act(() => useVoiceAssistantStore.getState().press());
		expect(dictationStart).toHaveBeenCalledTimes(sessions);

		fireEvent.click(screen.getByText("voiceAssistant:stop.yes"));
		await waitFor(() => expect(toast).toHaveBeenCalledWith({ variant, title }));
		expect(stopAgentsAfterStep).toHaveBeenCalledOnce();
		expect(useVoiceAssistantStore.getState().isOpen).toBe(false);
	});

	it("ends the sentence on a second press of the shortcut", async () => {
		renderAssistant();
		act(() => useVoiceAssistantStore.getState().press());
		await screen.findByText("voiceAssistant:phase.listening");
		act(() => useVoiceAssistantStore.setState({ lastPressAt: 0 }));
		act(() => useVoiceAssistantStore.getState().press());
		expect(stop).toHaveBeenCalled();
	});

	it("reads a stop without a project selected too", async () => {
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: null, projects: [] });
		await openAndSay("stop");
		expect(await screen.findByText("voiceAssistant:stop.confirm")).toBeInTheDocument();
	});

	it("keeps going when the person changes their mind", async () => {
		await openAndSay("arrête tout");
		fireEvent.click(await screen.findByText("voiceAssistant:stop.no"));
		await waitFor(() => expect(dictationStart).toHaveBeenCalledTimes(2));
		expect(stopAgentsAfterStep).not.toHaveBeenCalled();
		expect(await screen.findByText("voiceAssistant:phase.listening")).toBeInTheDocument();
	});

	it("listens with the chosen sensitivity, and ends the sentence on a silence after speech", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			renderAssistant();
			act(() => useVoiceAssistantStore.getState().press());
			await screen.findByText("voiceAssistant:phase.listening");
			// Low sensitivity: 0.01 over a quiet room is not a voice.
			expect(isVoice?.(0.001)).toBe(false);
			expect(isVoice?.(0.01)).toBe(false);
			act(() => level(0.4, false));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			expect(screen.getByText("voiceAssistant:phase.listening")).toBeInTheDocument();
			act(() => level(0.4, true));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			expect(stop).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("hands over to the continuous mode, which shows itself", async () => {
		renderAssistant();
		act(() => useVoiceAssistantStore.getState().press());
		await screen.findByText("voiceAssistant:phase.listening");
		fireEvent.click(screen.getByText("voiceAssistant:continuous.start"));
		expect(useVoiceAssistantStore.getState()).toMatchObject({ isOpen: false, continuous: true });
		expect(dictationCancel).toHaveBeenCalled();
		expect(await screen.findByRole("region", { name: "voiceAssistant:continuous.title" })).toBeInTheDocument();
	});
});
