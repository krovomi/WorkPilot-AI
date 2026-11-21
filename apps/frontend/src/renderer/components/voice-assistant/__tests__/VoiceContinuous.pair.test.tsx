import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { useTaskStore } from "../../../stores/task-store";
import { claimMicrophoneForForm, useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import { captureDictation } from "../../task-form/dictation-audio";
import { ECHO_MS } from "../use-continuous-capture";
import { VoiceContinuous } from "../VoiceContinuous";
import { installSpeech } from "./speech-fake";

vi.mock("../../task-form/dictation-audio", () => ({ captureDictation: vi.fn() }));
vi.mock("../../../stores/task-store", async () => {
	const { create } = await import("zustand");
	return { createTask: vi.fn(), useTaskStore: create(() => ({ tasks: [] as unknown[] })) };
});
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) => {
			const shown = values && Object.entries(values).filter(([, v]) => v !== undefined);
			return shown?.length ? `${key}:${shown.map(([, v]) => String(v)).join(",")}` : key;
		},
		i18n: { language: "fr" },
	}),
}));

const destinations = [{ id: "kanban", label: "Tableau Kanban" }];
const running = [
	{ id: "t1", specId: "001", title: "Export CSV", status: "in_progress", subtasks: [] },
	{ id: "t2", specId: "002-untitled", title: "", status: "ai_review", subtasks: [] },
	{ id: "t3", specId: "003", title: "Idle", status: "backlog", subtasks: [] },
];

const tick = (ms = 0) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

describe("VoiceContinuous: pair mode, spoken feedback and sharing the microphone", () => {
	let chunk: (audio: ArrayBuffer) => void;
	let level: (value: number, voiced: boolean) => void;
	let speech: ReturnType<typeof installSpeech>;
	const stop = Object.assign(vi.fn(), { flush: vi.fn() });
	const dictationStart = vi.fn();
	const dictationTranscribe = vi.fn();
	const dictationCancel = vi.fn();
	const interpretVoiceCommand = vi.fn();
	const sendTaskSteering = vi.fn();
	const stopAgentsAfterStep = vi.fn();
	const onNavigate = vi.fn();

	const show = async () => {
		render(
			<VoiceContinuous
				destinations={destinations}
				onNavigate={onNavigate}
				onNewTask={vi.fn()}
				onOpenSettings={vi.fn()}
			/>,
		);
		await tick();
	};

	/** The fake engine never ends a line by itself: finish what was said. */
	const hushed = () => act(() => speech.spoken.forEach((utterance) => utterance.onend?.()));

	const say = async (text: string, language?: string) => {
		hushed();
		await tick(ECHO_MS + 10);
		act(() => level(0.5, true));
		dictationTranscribe.mockResolvedValueOnce({ text, language });
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		await tick(2000);
	};

	const feedback = (value: "off" | "short" | "verbose") =>
		useSettingsStore.setState((state) => ({ settings: { ...state.settings, voiceAssistantFeedback: value } }));

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		interpretVoiceCommand.mockReset();
		speech = installSpeech();
		feedback("off");
		useVoiceAssistantStore.setState({
			isOpen: false,
			continuous: true,
			speaking: false,
			formDictations: 0,
			pairTaskId: null,
			pairNarration: "",
		});
		useTaskStore.setState({ tasks: running } as never);
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
			sendTaskSteering,
			stopAgentsAfterStep,
		});
		vi.mocked(captureDictation).mockImplementation(async (onChunk, onLevel) => {
			chunk = onChunk;
			level = onLevel;
			return stop;
		});
	});

	afterEach(() => {
		for (const utterance of speech.spoken) utterance.onend?.();
		speech.uninstall();
		vi.useRealTimers();
	});

	it("follows a running task and sends it what the person says, after a « yes »", async () => {
		sendTaskSteering.mockResolvedValueOnce({ success: true, data: [] });
		await show();
		const select = screen.getByLabelText("voiceAssistant:pair.follow");
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
			"voiceAssistant:pair.none",
			"Export CSV",
			"002-untitled",
		]);
		fireEvent.change(select, { target: { value: "t1" } });
		expect(useVoiceAssistantStore.getState().pairTaskId).toBe("t1");
		expect(screen.getByText("voiceAssistant:pair.hint")).toBeInTheDocument();
		act(() => useVoiceAssistantStore.setState({ pairNarration: "Export CSV : écriture du code." }));
		expect(screen.getByText("Export CSV : écriture du code.")).toBeInTheDocument();

		await say("utilise plutôt zod");
		expect(interpretVoiceCommand).not.toHaveBeenCalled();
		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"voiceAssistant:pair.sendQuestion:Export CSV,utilise plutôt zod",
		);
		await say("oui");
		expect(sendTaskSteering).toHaveBeenCalledWith("t1", "utilise plutôt zod");
		expect(screen.getByText("voiceAssistant:pair.sent:Export CSV,Export CSV")).toBeInTheDocument();

		sendTaskSteering.mockRejectedValueOnce(new Error("gone"));
		await say("Dis-lui d'ouvrir le tableau kanban");
		expect(onNavigate).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("voiceAssistant:pair.send"));
		await tick();
		expect(sendTaskSteering).toHaveBeenLastCalledWith("t1", "ouvrir le tableau kanban");
		expect(screen.getByText("voiceAssistant:pair.sendFailed:Export CSV,Export CSV")).toBeInTheDocument();

		fireEvent.change(select, { target: { value: "" } });
		expect(useVoiceAssistantStore.getState().pairTaskId).toBeNull();
	});

	it("follows an untitled task by its spec id, and lets go of one that stopped running", async () => {
		useVoiceAssistantStore.setState({ pairTaskId: "t2" });
		await show();
		await say("ajoute des tests");
		expect(screen.getByRole("alertdialog")).toHaveTextContent("voiceAssistant:pair.sendQuestion:002-untitled");
		fireEvent.click(screen.getByText("voiceAssistant:stop.no"));

		act(() => useTaskStore.setState({ tasks: [{ ...running[1], status: "done" }] } as never));
		// Still followed in the store, but no longer running: back to plain commands.
		expect(screen.getByLabelText("voiceAssistant:pair.follow")).toHaveValue("");
		await say("ajoute des tests");
		expect(interpretVoiceCommand).toHaveBeenCalledOnce();
	});

	it("offers no task to follow when none runs", async () => {
		useTaskStore.setState({ tasks: [running[2]] } as never);
		await show();
		expect(screen.queryByLabelText("voiceAssistant:pair.follow")).toBeNull();
	});

	it("says its answers and questions aloud with spoken feedback on", async () => {
		feedback("short");
		interpretVoiceCommand.mockResolvedValueOnce({ success: true, intent: { kind: "navigate", view: "roadmap" } });
		await show();
		await say("ouvre le tableau kanban");
		expect(speech.said()).toEqual(["voiceAssistant:speech.opening:Tableau Kanban"]);
		await say("fais quelque chose d'utile");
		expect(onNavigate).toHaveBeenLastCalledWith("roadmap");
		expect(speech.said()).toContain("voiceAssistant:speech.opening:roadmap");
		await say("stop");
		expect(speech.said()).toContain("voiceAssistant:stop.confirm");
		await say("Crée une tâche pour ajouter un export CSV");
		expect(speech.said()).toContain("voiceAssistant:continuous.createQuestion:Ajouter un export CSV");
		await say("non");
		expect(speech.said()).toContain("voiceAssistant:continuous.cancelled");
		useVoiceAssistantStore.setState({ pairTaskId: "t1" });
		await tick();
		await say("garde la v1");
		expect(speech.said()).toContain("voiceAssistant:pair.sendQuestion:Export CSV,garde la v1");
	});

	it("does not hear itself: what the microphone gets while the assistant speaks is dropped", async () => {
		await show();
		act(() => useVoiceAssistantStore.setState({ speaking: true }));
		act(() => level(0.5, true));
		act(() => chunk(new ArrayBuffer(44)));
		await tick(2000);
		expect(dictationTranscribe).not.toHaveBeenCalled();
		act(() => useVoiceAssistantStore.setState({ speaking: false }));
		// The room's echo, just after.
		act(() => chunk(new ArrayBuffer(44)));
		await tick(ECHO_MS + 10);
		expect(dictationTranscribe).not.toHaveBeenCalled();
		await say("ouvre le tableau kanban");
		expect(onNavigate).toHaveBeenCalledWith("kanban");
		expect(dictationStart).toHaveBeenCalledOnce();
	});

	it("reads the sentence in the language Whisper heard", async () => {
		await show();
		await say("do something useful", "en");
		expect(interpretVoiceCommand).toHaveBeenCalledWith("do something useful", expect.any(Array), "en", "p1");
		await say("fais quelque chose d'utile");
		expect(interpretVoiceCommand).toHaveBeenLastCalledWith(
			"fais quelque chose d'utile",
			expect.any(Array),
			"fr-FR",
			"p1",
		);
	});

	it("gives the microphone to the task form's dictation at once, and takes it back after", async () => {
		await show();
		const giveBack = claimMicrophoneForForm();
		expect(dictationCancel).toHaveBeenCalledOnce();
		await tick();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.dictating");
		giveBack();
		await tick();
		expect(dictationStart).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.listening");
	});

	it("stops talking when the microphone is muted", async () => {
		await show();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		expect(speech.engine.cancel).toHaveBeenCalledOnce();
	});
});
