import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { createTask } from "../../../stores/task-store";
import { useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import { captureDictation } from "../../task-form/dictation-audio";
import { VoiceAssistant } from "../VoiceAssistant";
import { installSpeech } from "./speech-fake";

vi.mock("../../task-form/dictation-audio", () => ({ captureDictation: vi.fn() }));
vi.mock("../../../stores/task-store", async () => {
	const { create } = await import("zustand");
	return { createTask: vi.fn(), useTaskStore: create(() => ({ tasks: [] as unknown[] })) };
});
vi.mock("../../../hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) => {
			const shown = values && Object.entries(values).filter(([, v]) => v !== undefined);
			return shown?.length ? `${key}:${shown.map(([, v]) => String(v)).join(",")}` : key;
		},
		i18n: { language: "fr" },
	}),
}));

const destinations = [
	{ id: "kanban", label: "Tableau Kanban" },
	{ id: "roadmap", label: "Feuille de route" },
];

describe("VoiceAssistant: spoken answers, the wake word's sentence, the language heard", () => {
	let chunk: (audio: ArrayBuffer) => void;
	let speech: ReturnType<typeof installSpeech>;
	const stop = vi.fn();
	const dictationStart = vi.fn();
	const dictationTranscribe = vi.fn();
	const dictationCancel = vi.fn();
	const interpretVoiceCommand = vi.fn();
	const stopAgentsAfterStep = vi.fn();
	const onNavigate = vi.fn();

	const open = (command?: string) => {
		render(
			<VoiceAssistant destinations={destinations} onNavigate={onNavigate} onNewTask={vi.fn()} onOpenSettings={vi.fn()} />,
		);
		act(() => {
			if (command) useVoiceAssistantStore.getState().openWith(command);
			else useVoiceAssistantStore.getState().open();
		});
	};

	const say = async (text: string, language?: string) => {
		await screen.findByText("voiceAssistant:phase.listening");
		dictationTranscribe.mockResolvedValueOnce({ text, language });
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.click(screen.getByLabelText("voiceAssistant:actions.stop"));
	};

	beforeEach(() => {
		vi.clearAllMocks();
		interpretVoiceCommand.mockReset();
		speech = installSpeech();
		localStorage.clear();
		useSettingsStore.setState((state) => ({ settings: { ...state.settings, voiceAssistantFeedback: "short" } }));
		useVoiceAssistantStore.setState({ isOpen: false, continuous: false, pressCount: 0, lastPressAt: 0, pendingCommand: null, speaking: false });
		useProjectStore.setState({
			activeProjectId: "p1",
			selectedProjectId: "p1",
			projects: [{ id: "p1", name: "Demo", path: "/repo" } as never],
		});
		dictationStart.mockResolvedValue({ ready: true });
		dictationCancel.mockResolvedValue(undefined);
		interpretVoiceCommand.mockResolvedValue({ success: false, error: "unparsable" });
		Object.assign(window.electronAPI, {
			dictationStart,
			dictationTranscribe,
			dictationCancel,
			interpretVoiceCommand,
			stopAgentsAfterStep,
		});
		vi.mocked(captureDictation).mockImplementation(async (callback) => {
			chunk = callback;
			return Object.assign(stop, { flush: vi.fn() });
		});
	});

	afterEach(() => {
		for (const utterance of speech.spoken) utterance.onend?.();
		speech.uninstall();
	});

	it("reads the sentence the wake word brought, without listening first", async () => {
		open("ouvre le tableau kanban");
		await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("kanban"));
		expect(dictationStart).not.toHaveBeenCalled();
		expect(speech.said()).toEqual(["voiceAssistant:speech.opening:Tableau Kanban"]);
		expect(useVoiceAssistantStore.getState().pendingCommand).toBeNull();
	});

	it("names a view the model chose that has no label by its id", async () => {
		interpretVoiceCommand.mockResolvedValueOnce({ success: true, intent: { kind: "navigate", view: "insights" } });
		open("fais quelque chose d'utile");
		await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("insights"));
		expect(speech.said()).toEqual(["voiceAssistant:speech.opening:insights"]);
	});

	it("says what it did not understand, the questions it asks, and their outcome", async () => {
		vi.mocked(createTask).mockResolvedValue({ id: "t1", title: "Ajouter un export CSV" } as never);
		stopAgentsAfterStep.mockResolvedValue({ success: true, data: { stoppingTasks: ["t1"], failedTasks: [] } });
		open();
		await say("bla bla");
		await screen.findByText("voiceAssistant:results.unknown:bla bla");
		expect(speech.said()).toContain("voiceAssistant:results.unknown:bla bla");

		fireEvent.click(screen.getByLabelText("voiceAssistant:actions.listen"));
		await say("Crée une tâche pour ajouter un export CSV");
		await screen.findByLabelText("voiceAssistant:confirm.title");
		expect(speech.said()).toContain("voiceAssistant:confirm.heading");
		fireEvent.click(screen.getByText("voiceAssistant:actions.create"));
		await waitFor(() => expect(useVoiceAssistantStore.getState().isOpen).toBe(false));
		expect(speech.said()).toContain("voiceAssistant:results.created:Ajouter un export CSV");

		act(() => useVoiceAssistantStore.getState().open());
		await say("stop");
		await screen.findByText("voiceAssistant:stop.explain");
		expect(speech.said()).toContain("voiceAssistant:stop.confirm");
		fireEvent.click(screen.getByText("voiceAssistant:stop.yes"));
		await waitFor(() => expect(speech.said()).toContain("voiceAssistant:stop.stopping:1"));
	});

	it("shows and uses the language Whisper heard when set to detect it, and forgets it on a new sentence", async () => {
		localStorage.setItem("voice-assistant-language", "auto");
		open();
		await say("do something useful", "en");
		await waitFor(() =>
			expect(interpretVoiceCommand).toHaveBeenCalledWith("do something useful", expect.any(Array), "en", "p1"),
		);
		expect(await screen.findByText(/voiceAssistant:heard:/)).toBeInTheDocument();
		// The shortcut pressed again listens again, without the old language.
		act(() => useVoiceAssistantStore.getState().press());
		await say("fais autre chose");
		await waitFor(() =>
			expect(interpretVoiceCommand).toHaveBeenLastCalledWith("fais autre chose", expect.any(Array), "auto", "p1"),
		);
		expect(screen.queryByText(/voiceAssistant:heard:/)).toBeNull();
	});

	it("joins the phrases of a sentence, skips an empty one, and names an untitled task by what was asked", async () => {
		vi.mocked(createTask).mockResolvedValue({ id: "t1", title: "" } as never);
		open();
		await screen.findByText("voiceAssistant:phase.listening");
		// A change of microphone settings while the panel is open keeps the session.
		act(() =>
			useSettingsStore.setState((state) => ({ settings: { ...state.settings, voiceAssistantSensitivity: "high" } })),
		);
		dictationTranscribe.mockResolvedValueOnce({ text: "Crée une tâche" });
		await act(async () => chunk(new ArrayBuffer(44)));
		dictationTranscribe.mockResolvedValueOnce({});
		await act(async () => chunk(new ArrayBuffer(44)));
		dictationTranscribe.mockResolvedValueOnce({ text: "pour ajouter un export CSV" });
		await act(async () => chunk(new ArrayBuffer(44)));
		expect(screen.getByLabelText("voiceAssistant:input.label")).toHaveValue(
			"Crée une tâche pour ajouter un export CSV",
		);
		expect(dictationStart).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByLabelText("voiceAssistant:actions.stop"));
		await screen.findByLabelText("voiceAssistant:confirm.title");
		fireEvent.click(screen.getByText("voiceAssistant:actions.create"));
		await waitFor(() => expect(speech.said()).toContain("voiceAssistant:results.created:Ajouter un export CSV"));
	});

	it("says nothing with spoken feedback off", async () => {
		useSettingsStore.setState((state) => ({ settings: { ...state.settings, voiceAssistantFeedback: "off" } }));
		open("ouvre le tableau kanban");
		await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("kanban"));
		expect(speech.said()).toEqual([]);
	});
});
