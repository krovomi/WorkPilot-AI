import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import { createTask } from "../../../stores/task-store";
import { useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import { captureDictation } from "../../task-form/dictation-audio";
import { VoiceAssistant } from "../VoiceAssistant";

vi.mock("../../task-form/dictation-audio", () => ({ captureDictation: vi.fn() }));
vi.mock("../../../stores/task-store", () => ({ createTask: vi.fn() }));
vi.mock("../../../hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values?.text ? `${key}:${String(values.text)}` : key,
		i18n: { language: "fr" },
	}),
}));

const destinations = [
	{ id: "kanban", label: "Tableau Kanban" },
	{ id: "visual-to-code", label: "Visuel vers Code" },
	{ id: "roadmap", label: "Feuille de route" },
	{ id: "voice-control", label: "Assistant vocal" },
];

function pressShortcut(target: Element = document.body) {
	fireEvent.keyDown(target, { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
}

describe("VoiceAssistant", () => {
	let chunk: (audio: ArrayBuffer) => void;
	const stop = vi.fn();
	const dictationStart = vi.fn();
	const dictationTranscribe = vi.fn();
	const dictationCancel = vi.fn();
	const interpretVoiceCommand = vi.fn();
	const onNavigate = vi.fn();
	const onNewTask = vi.fn();
	const onOpenSettings = vi.fn();

	const renderAssistant = () =>
		render(
			<VoiceAssistant
				destinations={destinations}
				onNavigate={onNavigate}
				onNewTask={onNewTask}
				onOpenSettings={onOpenSettings}
			/>,
		);

	const say = async (text: string) => {
		await screen.findByText("voiceAssistant:phase.listening");
		dictationTranscribe.mockResolvedValueOnce({ text });
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.click(screen.getByLabelText("voiceAssistant:actions.stop"));
	};

	beforeEach(() => {
		vi.clearAllMocks();
		useVoiceAssistantStore.setState({ isOpen: false, pressCount: 0, lastPressAt: 0 });
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
			interpretVoiceCommand,
		});
		vi.mocked(captureDictation).mockImplementation(async (callback) => {
			chunk = callback;
			return stop;
		});
	});

	it("opens from the shortcut anywhere, a text field included, and starts listening", async () => {
		renderAssistant();
		const field = document.createElement("textarea");
		document.body.appendChild(field);
		field.focus();
		pressShortcut(field);
		await waitFor(() => expect(dictationStart).toHaveBeenCalledWith(expect.any(String), false, "/repo"));
		expect(await screen.findByText("voiceAssistant:phase.listening")).toBeInTheDocument();
		field.remove();
	});

	it("opens a view named in the sentence without asking a model", async () => {
		renderAssistant();
		pressShortcut();
		await say("Ouvre Visuel vers Code");
		await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("visual-to-code"));
		expect(interpretVoiceCommand).not.toHaveBeenCalled();
		expect(useVoiceAssistantStore.getState().isOpen).toBe(false);
		expect(stop).toHaveBeenCalled();
	});

	it("asks for confirmation, then creates the task in the active project", async () => {
		vi.mocked(createTask).mockResolvedValue({ id: "t1", title: "Ajouter un export CSV" } as never);
		renderAssistant();
		pressShortcut();
		await say("Crée-moi une tâche dans le kanban pour ajouter un export CSV");
		const title = await screen.findByLabelText("voiceAssistant:confirm.title");
		expect(title).toHaveValue("Ajouter un export CSV");
		expect(createTask).not.toHaveBeenCalled();
		fireEvent.change(title, { target: { value: "Export CSV des tâches" } });
		fireEvent.click(screen.getByText("voiceAssistant:actions.create"));
		await waitFor(() =>
			expect(createTask).toHaveBeenCalledWith("p1", "Export CSV des tâches", "ajouter un export CSV"),
		);
		await waitFor(() => expect(useVoiceAssistantStore.getState().isOpen).toBe(false));
	});

	it("hands an unsure sentence to the model, with the views offered (not itself)", async () => {
		interpretVoiceCommand.mockResolvedValue({
			success: true,
			intent: { kind: "navigate", view: "roadmap" },
		});
		renderAssistant();
		pressShortcut();
		await say("où en est le plan produit du trimestre");
		await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("roadmap"));
		const [sentence, offered, language, projectId] = interpretVoiceCommand.mock.calls[0];
		expect(sentence).toBe("où en est le plan produit du trimestre");
		expect(offered.map((d: { id: string }) => d.id)).toEqual(["kanban", "visual-to-code", "roadmap"]);
		expect(language).toBe("fr-FR");
		expect(projectId).toBe("p1");
	});

	it("says so when no model answers and the words alone are not enough", async () => {
		interpretVoiceCommand.mockResolvedValue({ success: false, error: "unavailable" });
		renderAssistant();
		act(() => useVoiceAssistantStore.getState().open());
		await screen.findByText("voiceAssistant:phase.listening");
		const input = screen.getByLabelText("voiceAssistant:input.label");
		fireEvent.change(input, { target: { value: "quelle heure est-il" } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		expect(
			await screen.findByText("voiceAssistant:results.noModel:quelle heure est-il"),
		).toBeInTheDocument();
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it("offers the model download when the speech model is missing", async () => {
		dictationStart.mockResolvedValueOnce({ error: "model" });
		renderAssistant();
		act(() => useVoiceAssistantStore.getState().open());
		fireEvent.click(await screen.findByText("voiceAssistant:actions.download"));
		await waitFor(() => expect(dictationStart).toHaveBeenLastCalledWith(expect.any(String), true, "/repo"));
	});
});
