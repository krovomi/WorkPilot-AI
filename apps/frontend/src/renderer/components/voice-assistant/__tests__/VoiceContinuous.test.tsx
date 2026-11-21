import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import { createTask } from "../../../stores/task-store";
import { useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import { captureDictation } from "../../task-form/dictation-audio";
import { MAX_SENTENCE_MS } from "../use-continuous-capture";
import { VoiceContinuous } from "../VoiceContinuous";

vi.mock("../../task-form/dictation-audio", () => ({ captureDictation: vi.fn() }));
vi.mock("../../../stores/task-store", () => ({ createTask: vi.fn() }));
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

/** Let pending promises and the sentence timer run. */
const tick = (ms = 0) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

describe("VoiceContinuous", () => {
	let chunk: (audio: ArrayBuffer) => void;
	let level: (value: number, voiced: boolean) => void;
	let ended: () => void;
	const stop = Object.assign(vi.fn(), { flush: vi.fn() });
	const dictationStart = vi.fn();
	const dictationTranscribe = vi.fn();
	const dictationCancel = vi.fn();
	const interpretVoiceCommand = vi.fn();
	const stopAgentsAfterStep = vi.fn();
	const onNavigate = vi.fn();
	const onNewTask = vi.fn();
	const onOpenSettings = vi.fn();

	const show = async () => {
		const view = render(
			<VoiceContinuous
				destinations={destinations}
				onNavigate={onNavigate}
				onNewTask={onNewTask}
				onOpenSettings={onOpenSettings}
			/>,
		);
		await tick();
		return view;
	};

	/** Speak a sentence: voice heard, its phrase transcribed, then a silence. */
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
		useVoiceAssistantStore.setState({ isOpen: false, continuous: true, pressCount: 0, lastPressAt: 0 });
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
		vi.mocked(captureDictation).mockImplementation(async (onChunk, onLevel, onEnded) => {
			chunk = onChunk;
			level = onLevel;
			ended = onEnded;
			return stop;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows nothing until the person starts it", () => {
		useVoiceAssistantStore.setState({ continuous: false });
		const { container } = render(
			<VoiceContinuous
				destinations={destinations}
				onNavigate={onNavigate}
				onNewTask={onNewTask}
				onOpenSettings={onOpenSettings}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
		expect(dictationStart).not.toHaveBeenCalled();
	});

	it("keeps one session open and acts on each sentence, showing it as it is transcribed", async () => {
		await show();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.listening");
		expect(screen.getByText("voiceAssistant:continuous.hint")).toBeInTheDocument();
		expect(dictationStart).toHaveBeenCalledWith(expect.any(String), false, "/repo");

		act(() => level(0.5, true));
		act(() => level(0.5, false));
		dictationTranscribe.mockResolvedValueOnce({ text: "Ouvre le tableau" });
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		expect(screen.getByText("Ouvre le tableau")).toBeInTheDocument();
		dictationTranscribe.mockResolvedValueOnce({ text: "kanban" });
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		expect(screen.getByText("Ouvre le tableau kanban")).toBeInTheDocument();
		// Still speaking: no sentence yet.
		await tick(1000);
		expect(onNavigate).not.toHaveBeenCalled();
		await tick(1000);
		expect(stop.flush).toHaveBeenCalled();
		expect(onNavigate).toHaveBeenCalledWith("kanban");
		expect(screen.getByText("voiceAssistant:continuous.hint")).toBeInTheDocument();

		await say("nouvelle tâche");
		expect(onNewTask).toHaveBeenCalledOnce();
		await say("ouvre les paramètres");
		expect(onOpenSettings).toHaveBeenCalledOnce();
		expect(dictationStart).toHaveBeenCalledTimes(1);
	});

	it("ends a sentence that goes on too long, and drops one with no words", async () => {
		await show();
		// Heard as voice, but nothing transcribed: no sentence.
		act(() => level(0.5, true));
		await tick(2000);
		expect(interpretVoiceCommand).not.toHaveBeenCalled();

		dictationTranscribe.mockResolvedValueOnce({ text: "bla" });
		act(() => level(0.5, true));
		act(() => chunk(new ArrayBuffer(44)));
		for (let elapsed = 0; elapsed <= MAX_SENTENCE_MS; elapsed += 1000) {
			act(() => level(0.5, true));
			await tick(1000);
		}
		expect(interpretVoiceCommand).toHaveBeenCalledWith("bla", expect.any(Array), "fr-FR", "p1");
		expect(screen.getByText("voiceAssistant:results.unknown:bla,bla")).toBeInTheDocument();
	});

	it("asks before a spoken stop, and a « yes » stops the agents after their step", async () => {
		stopAgentsAfterStep.mockResolvedValue({ success: true, data: { stoppingTasks: ["t1"], failedTasks: [] } });
		await show();
		await say("Stop");
		expect(screen.getByRole("alertdialog")).toHaveTextContent("voiceAssistant:stop.confirm");
		expect(stopAgentsAfterStep).not.toHaveBeenCalled();
		await say("oui");
		expect(stopAgentsAfterStep).toHaveBeenCalledOnce();
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(screen.getByText("voiceAssistant:stop.stopping:1")).toBeInTheDocument();
	});

	it("drops the question on a « no », or on another command", async () => {
		await show();
		await say("arrête tout");
		await say("non");
		expect(screen.getByText("voiceAssistant:continuous.cancelled")).toBeInTheDocument();
		await say("stop");
		await say("ouvre le tableau kanban");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onNavigate).toHaveBeenCalledWith("kanban");
		expect(stopAgentsAfterStep).not.toHaveBeenCalled();
	});

	it("answers the question with its buttons too", async () => {
		stopAgentsAfterStep.mockResolvedValue({ success: true, data: { stoppingTasks: [], failedTasks: [] } });
		await show();
		await say("stop");
		fireEvent.click(screen.getByText("voiceAssistant:stop.no"));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		await say("stop");
		fireEvent.click(screen.getByText("voiceAssistant:stop.yes"));
		await tick();
		expect(screen.getByText("voiceAssistant:stop.none:0")).toBeInTheDocument();
	});

	it("creates a task once the person says yes, and says when it fails", async () => {
		vi.mocked(createTask).mockResolvedValueOnce({ id: "t1", title: "" } as never);
		await show();
		await say("Crée une tâche pour ajouter un export CSV");
		expect(screen.getByRole("alertdialog")).toHaveTextContent(
			"voiceAssistant:continuous.createQuestion:Ajouter un export CSV",
		);
		await say("oui");
		expect(createTask).toHaveBeenCalledWith("p1", "Ajouter un export CSV", "ajouter un export CSV");
		expect(screen.getByText(/voiceAssistant:results\.created:Ajouter un export CSV/)).toBeInTheDocument();

		vi.mocked(createTask).mockResolvedValueOnce(null as never);
		await say("Crée une tâche pour ajouter un export CSV");
		fireEvent.click(screen.getByText("voiceAssistant:actions.create"));
		await tick();
		expect(screen.getByText("voiceAssistant:results.createFailed")).toBeInTheDocument();
	});

	it("needs a project to create a task", async () => {
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: null, projects: [] });
		await show();
		expect(dictationStart).toHaveBeenCalledWith(expect.any(String), false, undefined);
		await say("Crée une tâche pour ajouter un export CSV");
		expect(screen.getByText("voiceAssistant:results.noProject")).toBeInTheDocument();
		// A « yes » with nothing asked is just a sentence.
		await say("oui");
		expect(createTask).not.toHaveBeenCalled();
	});

	it("says it is thinking while the model reads a sentence, and when it understood nothing", async () => {
		let answer!: (value: unknown) => void;
		interpretVoiceCommand.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		await show();
		await say("montre-moi ce qui est prévu");
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.thinking");
		await act(async () => answer({ success: true, intent: { kind: "unknown" } }));
		expect(screen.getByText("voiceAssistant:results.unknown:montre-moi ce qui est prévu,montre-moi ce qui est prévu")).toBeInTheDocument();
	});

	it("mutes the microphone, pauses while the panel is open, and closes", async () => {
		await show();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		await tick();
		expect(stop).toHaveBeenCalledWith(true);
		expect(dictationCancel).toHaveBeenCalledOnce();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.muted");
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		expect(dictationStart).toHaveBeenCalledTimes(2);

		act(() => useVoiceAssistantStore.setState({ isOpen: true }));
		await tick();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.paused");
		expect(dictationCancel).toHaveBeenCalledTimes(2);
		act(() => useVoiceAssistantStore.setState({ isOpen: false }));
		await tick();
		expect(dictationStart).toHaveBeenCalledTimes(3);

		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.close"));
		expect(useVoiceAssistantStore.getState().continuous).toBe(false);
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("shows a microphone that cannot start, and tries again on demand", async () => {
		dictationStart.mockResolvedValueOnce({ error: "model" });
		await show();
		expect(screen.getByRole("alert")).toHaveTextContent("voiceAssistant:errors.model");
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.off");
		fireEvent.click(screen.getByText("voiceAssistant:actions.retry"));
		await tick();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent("voiceAssistant:continuous.phase.listening");
	});

	it.each([
		["a refused microphone", () => vi.mocked(captureDictation).mockRejectedValueOnce("denied"), "microphone"],
		["an unknown failure", () => dictationStart.mockResolvedValueOnce({ ready: false }), "transcription"],
		["a strange code", () => dictationStart.mockResolvedValueOnce({ error: "weird" }), "microphone"],
	])("names %s", async (_name, arrange, code) => {
		arrange();
		await show();
		expect(screen.getByRole("alert")).toHaveTextContent(`voiceAssistant:errors.${code}`);
	});

	it("stops on a transcription error or a microphone that goes away", async () => {
		await show();
		dictationTranscribe.mockResolvedValueOnce({ error: "transcription" });
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		expect(screen.getByRole("alert")).toHaveTextContent("voiceAssistant:errors.transcription");
		fireEvent.click(screen.getByText("voiceAssistant:actions.retry"));
		await tick();
		dictationTranscribe.mockRejectedValueOnce(new Error("gone"));
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		expect(screen.getByRole("alert")).toHaveTextContent("voiceAssistant:errors.transcription");
		fireEvent.click(screen.getByText("voiceAssistant:actions.retry"));
		await tick();
		act(() => ended());
		await tick();
		expect(screen.getByRole("alert")).toHaveTextContent("voiceAssistant:errors.microphone");
	});

	it("skips a phrase transcribed to nothing, and a microphone that fails once muted", async () => {
		await show();
		dictationTranscribe.mockResolvedValueOnce({});
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		expect(screen.getByText("voiceAssistant:continuous.hint")).toBeInTheDocument();

		let refuse!: (reason: unknown) => void;
		vi.mocked(captureDictation).mockImplementationOnce(
			() => new Promise((_resolve, reject) => (refuse = reject)),
		);
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		await act(async () => refuse(new Error("microphone")));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("ignores what arrives for a session it already closed", async () => {
		// Muted while the dictation starts.
		let ready!: (value: unknown) => void;
		dictationStart.mockReturnValueOnce(new Promise((resolve) => (ready = resolve)));
		await show();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		await act(async () => ready({ ready: true }));
		expect(captureDictation).not.toHaveBeenCalled();
		// A failure of that closed session says nothing either.
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		let late!: (value: unknown) => void;
		dictationStart.mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		await act(async () => late({ error: "model" }));
		expect(screen.queryByRole("alert")).toBeNull();

		// Muted while the microphone opens: it is released at once.
		let opened!: (value: typeof stop) => void;
		vi.mocked(captureDictation).mockImplementationOnce(async (onChunk, onLevel, onEnded) => {
			chunk = onChunk;
			level = onLevel;
			ended = onEnded;
			return new Promise((resolve) => (opened = resolve));
		});
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		stop.mockClear();
		await act(async () => opened(stop));
		expect(stop).toHaveBeenCalledWith(true);
	});

	it("drops audio and sentences of a session muted in the meantime", async () => {
		await show();
		// A phrase queued, then muted before its transcription runs or returns.
		let text!: (value: unknown) => void;
		dictationTranscribe.mockReturnValueOnce(new Promise((resolve) => (text = resolve)));
		act(() => chunk(new ArrayBuffer(44)));
		act(() => chunk(new ArrayBuffer(44)));
		await tick();
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		await act(async () => text({ text: "trop tard" }));
		expect(dictationTranscribe).toHaveBeenCalledOnce();
		expect(screen.queryByText("trop tard")).toBeNull();

		// A sentence ended, muted while its last phrase is transcribed.
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.unmute"));
		await tick();
		let last!: (value: unknown) => void;
		dictationTranscribe.mockReturnValueOnce(new Promise((resolve) => (last = resolve)));
		act(() => level(0.5, true));
		act(() => chunk(new ArrayBuffer(44)));
		await tick(2000);
		fireEvent.click(screen.getByLabelText("voiceAssistant:continuous.mute"));
		await act(async () => last({ text: "ouvre le tableau kanban" }));
		expect(onNavigate).not.toHaveBeenCalled();
	});
});
