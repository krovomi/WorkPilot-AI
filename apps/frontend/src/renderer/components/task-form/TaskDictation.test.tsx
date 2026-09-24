import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDictation } from "./TaskDictation";
import { captureDictation } from "./dictation-audio";

vi.mock("./dictation-audio", () => ({ captureDictation: vi.fn() }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "fr" } }),
}));

describe("editable task dictation", () => {
	let chunk: (audio: ArrayBuffer) => void;
	const stop = vi.fn();
	const start = vi.fn();
	const transcribe = vi.fn();
	const cancel = vi.fn();
	beforeEach(() => {
		vi.clearAllMocks();
		start.mockResolvedValue({ ready: true });
		cancel.mockResolvedValue(undefined);
		Object.assign(window.electronAPI, {
			dictationStart: start,
			dictationTranscribe: transcribe,
			dictationCancel: cancel,
		});
		vi.mocked(captureDictation).mockImplementation(async (callback) => {
			chunk = callback;
			return stop;
		});
	});
	it("preserves manual corrections and concurrent ticket edits; inserts only once", async () => {
		const change = vi.fn();
		const view = render(
			<TaskDictation
				description="Original"
				onChange={change}
				richText={false}
			/>,
		);
		fireEvent.click(screen.getByText("dictation.start"));
		await screen.findByText("dictation.recording", { exact: false });
		transcribe.mockResolvedValueOnce({ text: "Créer une factur." });
		await act(async () => chunk(new ArrayBuffer(44)));
		const draft = screen.getByLabelText(
			"dictation.draft",
		) as HTMLTextAreaElement;
		fireEvent.change(draft, { target: { value: "Créer une facture." } });
		view.rerender(
			<TaskDictation
				description="Typed meanwhile"
				onChange={change}
				richText={false}
			/>,
		);
		draft.focus();
		draft.setSelectionRange(3, 7);
		transcribe.mockResolvedValueOnce({ text: "Puis envoyer à José." });
		await act(async () => chunk(new ArrayBuffer(44)));
		expect(draft).toHaveValue("Créer une facture. Puis envoyer à José.");
		expect(draft.selectionStart).toBe(3);
		expect(draft.selectionEnd).toBe(7);
		expect(change).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("dictation.stop"));
		await waitFor(() =>
			expect(screen.getByText("dictation.insert")).toBeEnabled(),
		);
		fireEvent.click(screen.getByText("dictation.insert"));
		expect(change).toHaveBeenCalledExactlyOnceWith(
			"Typed meanwhile\n\nCréer une facture. Puis envoyer à José.",
		);
		expect(screen.queryByText("dictation.insert")).not.toBeInTheDocument();
	});
	it("ignores late speech after cancellation and stops microphone on unmount", async () => {
		const view = render(
			<TaskDictation description="" onChange={vi.fn()} richText={false} />,
		);
		fireEvent.click(screen.getByText("dictation.start"));
		await screen.findByText("dictation.recording", { exact: false });
		let resolve!: (value: { text: string }) => void;
		transcribe.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.click(screen.getByText("dictation.cancel"));
		await act(async () => resolve({ text: "Must not return" }));
		expect(
			screen.queryByDisplayValue("Must not return"),
		).not.toBeInTheDocument();
		expect(stop).toHaveBeenCalledWith(true);
		view.unmount();
	});
	it("preserves composed characters while the last phrase finishes", async () => {
		render(
			<TaskDictation description="" onChange={vi.fn()} richText={false} />,
		);
		fireEvent.click(screen.getByText("dictation.start"));
		await screen.findByText("dictation.recording", { exact: false });
		const draft = screen.getByLabelText("dictation.draft");
		fireEvent.compositionStart(draft);
		fireEvent.change(draft, { target: { value: "Créer" } });
		transcribe.mockResolvedValueOnce({ text: "une tâche." });
		await act(async () => chunk(new ArrayBuffer(44)));
		expect(draft).toHaveValue("Créer");
		fireEvent.click(screen.getByText("dictation.stop"));
		await act(async () => Promise.resolve());
		fireEvent.compositionEnd(draft);
		expect(draft).toHaveValue("Créer une tâche.");
	});

	it("releases a microphone that opens after the user cancelled", async () => {
		let opened!: (stop: (discard?: boolean) => void) => void;
		vi.mocked(captureDictation).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					opened = resolve;
				}),
		);
		const pending = vi.fn();
		render(
			<TaskDictation
				description=""
				onChange={vi.fn()}
				richText={false}
				onPendingChange={pending}
			/>,
		);
		fireEvent.click(screen.getByText("dictation.start"));
		await waitFor(() => expect(captureDictation).toHaveBeenCalled());
		expect(pending).toHaveBeenLastCalledWith(true);
		fireEvent.click(screen.getByText("dictation.cancel"));
		await act(async () => opened(stop));
		expect(stop).toHaveBeenCalledWith(true);
		expect(pending).toHaveBeenLastCalledWith(false);
	});
});
