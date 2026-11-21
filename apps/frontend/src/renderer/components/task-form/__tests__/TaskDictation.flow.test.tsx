/**
 * @vitest-environment jsdom
 */

/**
 * TaskDictation in English: the spoken language remembered, the recording
 * clock, every error the engine can report, the model download, the backlog
 * guard, a session that ends while an answer is on its way, and the undo of
 * an insertion. The microphone (`captureDictation`) and `electronAPI` are the
 * boundaries.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { captureDictation } from "../dictation-audio";
import { TaskDictation } from "../TaskDictation";

vi.mock("../dictation-audio", () => ({ captureDictation: vi.fn() }));

const api = {
	dictationStart: vi.fn(),
	dictationTranscribe: vi.fn(),
	dictationCancel: vi.fn(),
};
const stop = vi.fn();
let chunk: (audio: ArrayBuffer) => void;
let ended: () => void;
const originalApi = window.electronAPI;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	localStorage.clear();
	for (const fn of Object.values(api)) fn.mockReset();
	stop.mockReset();
	api.dictationStart.mockResolvedValue({ ready: true });
	api.dictationCancel.mockResolvedValue(undefined);
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
	vi.mocked(captureDictation).mockReset().mockImplementation(async (onChunk, _onLevel, onEnded) => {
		chunk = onChunk;
		ended = onEnded;
		return Object.assign(stop, { flush: vi.fn() });
	});
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
afterAll(async () => {
	(window as unknown as { electronAPI: unknown }).electronAPI = originalApi;
	await i18n.changeLanguage("en");
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function Field({
	initial = "",
	richText = false,
	...props
}: { initial?: string; richText?: boolean } & Partial<Parameters<typeof TaskDictation>[0]>) {
	const [description, setDescription] = useState(initial);
	return (
		<>
			<div data-testid="description">{description}</div>
			<button type="button" onClick={() => setDescription(`${description}!`)}>
				Type in description
			</button>
			<TaskDictation description={description} onChange={setDescription} richText={richText} {...props} />
		</>
	);
}

const startButton = () => screen.getByRole("button", { name: /^(Dictate|Resume dictation)$/ });
const languageSelect = () => screen.getByRole("combobox", { name: "Spoken language" });

async function record() {
	fireEvent.click(startButton());
	await screen.findByRole("button", { name: "Stop" });
}

describe("TaskDictation — language", () => {
	it("follows the app's language, then remembers the one picked", () => {
		const setItem = vi.spyOn(localStorage, "setItem");
		render(<Field />);
		expect(languageSelect()).toHaveValue("en-US");
		expect(screen.getByRole("option", { name: "Detect language" })).toBeInTheDocument();
		fireEvent.change(languageSelect(), { target: { value: "de-CH" } });
		expect(setItem).toHaveBeenCalledWith("task-dictation-language", "de-CH");
		cleanup();

		render(<Field />);
		expect(languageSelect()).toHaveValue("de-CH");
	});

	it("ignores a stored language it does not offer, and storage that fails", () => {
		localStorage.setItem("task-dictation-language", "tlh");
		render(<Field />);
		expect(languageSelect()).toHaveValue("en-US");
		cleanup();

		vi.spyOn(localStorage, "getItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		render(<Field />);
		fireEvent.change(languageSelect(), { target: { value: "ja-JP" } });
		expect(languageSelect()).toHaveValue("ja-JP");
	});

	it("detects the language when the app speaks one it does not list", async () => {
		await i18n.changeLanguage("ko");
		render(<Field />);
		expect(languageSelect()).toHaveValue("auto");
		await record();
		expect(screen.getByRole("textbox", { name: "Editable voice draft" })).toHaveAttribute("lang", "ko");
	});
});

describe("TaskDictation — recording", () => {
	it("counts the time spent listening and shows the microphone level", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		render(<Field projectPath="/work/app" />);
		await record();
		expect(api.dictationStart).toHaveBeenCalledWith(expect.any(String), false, "/work/app");
		expect(screen.getByRole("meter", { name: "Microphone level" })).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(61_000);
		});
		expect(screen.getByRole("status")).toHaveTextContent("Listening · 1:01");
		expect(screen.getByRole("textbox", { name: "Editable voice draft" })).toHaveAttribute("lang", "en-US");
	});

	it("stops when the microphone goes away, and only once", async () => {
		render(<Field />);
		await record();
		act(() => ended());
		expect(stop).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
		act(() => ended());
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("skips silence and inserts the draft as a paragraph in a rich description", async () => {
		render(<Field initial="<p>Intro</p>" richText />);
		await record();
		api.dictationTranscribe.mockResolvedValueOnce({ text: "" });
		await act(async () => chunk(new ArrayBuffer(44)));
		const draft = screen.getByRole("textbox", { name: "Editable voice draft" });
		expect(draft).toHaveValue("");
		expect(screen.getByRole("button", { name: "Add to description" })).toBeDisabled();
		api.dictationTranscribe.mockResolvedValueOnce({ text: "Add <tests>" });
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.compositionStart(draft);
		fireEvent.compositionEnd(draft);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Add to description" })).toBeEnabled());
		expect(startButton()).toHaveTextContent("Resume dictation");
		fireEvent.click(screen.getByRole("button", { name: "Add to description" }));
		expect(screen.getByTestId("description")).toHaveTextContent("<p>Intro</p><p>Add &lt;tests&gt;</p>");
	});

	it("undoes an insertion while the description is still the inserted text", async () => {
		render(<Field initial="Before" />);
		await record();
		api.dictationTranscribe.mockResolvedValueOnce({ text: "spoken" });
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Add to description" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Add to description" }));
		expect(screen.getByTestId("description").textContent).toBe("Before\n\nspoken");
		fireEvent.click(screen.getByRole("button", { name: "Undo insertion" }));
		expect(screen.getByTestId("description").textContent).toBe("Before");
		expect(screen.queryByRole("button", { name: "Undo insertion" })).not.toBeInTheDocument();
	});

	it("offers no undo once the description was edited after the insertion", async () => {
		render(<Field initial="Before" />);
		await record();
		api.dictationTranscribe.mockResolvedValueOnce({ text: "spoken" });
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Add to description" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Add to description" }));
		fireEvent.click(screen.getByRole("button", { name: "Type in description" }));
		expect(screen.queryByRole("button", { name: "Undo insertion" })).not.toBeInTheDocument();
	});

	it("stops recording when the form becomes busy, and when it closes", async () => {
		const { rerender, unmount } = render(<Field />);
		await record();
		rerender(<Field disabled />);
		expect(stop).toHaveBeenCalledWith(true);
		expect(api.dictationCancel).toHaveBeenCalledTimes(1);
		expect(startButton()).toBeDisabled();

		rerender(<Field />);
		api.dictationCancel.mockRejectedValue(new Error("window closing"));
		await record();
		unmount();
		expect(api.dictationCancel).toHaveBeenCalledTimes(2);
		expect(stop).toHaveBeenLastCalledWith(true);
	});
});

describe("TaskDictation — errors", () => {
	it.each([
		[{ error: "offline" }, "Strict offline mode prevents downloading a model."],
		[{ error: "busy" }, "Another dictation session is active."],
		[{ ready: false }, "Transcription stopped unexpectedly."],
		[{ error: "something new" }, "Unable to open the microphone."],
	])("explains why dictation could not start (%j)", async (result, text) => {
		api.dictationStart.mockResolvedValueOnce(result);
		render(<Field />);
		fireEvent.click(startButton());
		expect(await screen.findByRole("alert")).toHaveTextContent(text);
		expect(captureDictation).not.toHaveBeenCalled();
		expect(startButton()).toBeEnabled();
	});

	it("says the microphone could not be opened", async () => {
		vi.mocked(captureDictation).mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
		render(<Field />);
		fireEvent.click(startButton());
		expect(await screen.findByRole("alert")).toHaveTextContent("Unable to open the microphone.");
		cleanup();

		api.dictationStart.mockRejectedValueOnce("not an error");
		render(<Field />);
		fireEvent.click(startButton());
		expect(await screen.findByRole("alert")).toHaveTextContent("Unable to open the microphone.");
	});

	it("stops and keeps the draft when a phrase cannot be transcribed", async () => {
		render(<Field />);
		await record();
		api.dictationTranscribe.mockResolvedValueOnce({ text: "kept" });
		await act(async () => chunk(new ArrayBuffer(44)));
		api.dictationTranscribe.mockResolvedValueOnce({ error: "engine crashed" });
		await act(async () => chunk(new ArrayBuffer(44)));
		expect(screen.getByRole("alert")).toHaveTextContent("Transcription stopped unexpectedly.");
		expect(stop).toHaveBeenCalledWith(true);
		expect(screen.getByRole("textbox", { name: "Editable voice draft" })).toHaveValue("kept");
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
	});

	it("stops listening when transcription falls behind, then finishes the queue", async () => {
		render(<Field />);
		await record();
		const answers = [deferred(), deferred(), deferred(), deferred()];
		for (const answer of answers) api.dictationTranscribe.mockReturnValueOnce(answer.promise);
		await act(async () => {
			for (let i = 0; i < 4; i++) chunk(new ArrayBuffer(44));
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Transcription is catching up.");
		expect(screen.getByRole("status")).toHaveTextContent("Finishing transcription…");
		expect(stop).toHaveBeenCalledWith();
		for (const [i, answer] of answers.entries()) {
			await act(async () => answer.resolve({ text: `phrase ${i + 1}` }));
		}
		await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
		expect(screen.getByRole("textbox", { name: "Editable voice draft" })).toHaveValue(
			"phrase 1 phrase 2 phrase 3 phrase 4",
		);
		expect(api.dictationCancel).toHaveBeenCalledTimes(1);
	});
});

describe("TaskDictation — the model download", () => {
	it("downloads the model for the project, then waits for a new start", async () => {
		api.dictationStart.mockResolvedValueOnce({ error: "model" });
		const { rerender } = render(<Field />);
		fireEvent.click(startButton());
		const download = await screen.findByRole("button", { name: /Download multilingual model/ });
		expect(download).toBeDisabled();

		rerender(<Field projectPath="/work/app" />);
		const finished = deferred<{ ready: boolean }>();
		api.dictationStart.mockReturnValueOnce(finished.promise);
		fireEvent.click(download);
		expect(await screen.findByRole("status")).toHaveTextContent("Downloading the local speech model…");
		expect(api.dictationStart).toHaveBeenLastCalledWith(expect.any(String), true, "/work/app");
		await act(async () => finished.resolve({ ready: true }));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(captureDictation).not.toHaveBeenCalled();
		// The session of the failed start, then the download's.
		expect(api.dictationCancel).toHaveBeenCalledTimes(2);
	});
});

describe("TaskDictation — a session that ended meanwhile", () => {
	const discard = () => fireEvent.click(screen.getByRole("button", { name: "Discard voice draft" }));

	it("ignores a start answer, a success or a failure, after the draft was discarded", async () => {
		const started = deferred<{ ready: boolean }>();
		api.dictationStart.mockReturnValueOnce(started.promise);
		render(<Field />);
		fireEvent.click(startButton());
		discard();
		await act(async () => started.resolve({ ready: true }));
		expect(captureDictation).not.toHaveBeenCalled();

		const failing = deferred<{ ready: boolean }>();
		api.dictationStart.mockReturnValueOnce(failing.promise);
		fireEvent.click(startButton());
		discard();
		await act(async () => failing.reject(new Error("busy")));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("drops speech that arrives after the draft was discarded", async () => {
		render(<Field />);
		await record();
		const first = deferred<{ text: string }>();
		const late = deferred<{ text: string }>();
		api.dictationTranscribe.mockReturnValueOnce(first.promise).mockReturnValueOnce(late.promise);
		await act(async () => {
			chunk(new ArrayBuffer(44));
			chunk(new ArrayBuffer(44));
		});
		discard();
		await act(async () => first.reject(new Error("cancelled")));
		chunk(new ArrayBuffer(44));
		expect(api.dictationTranscribe).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("does not end a new session when the old one finishes its queue", async () => {
		render(<Field />);
		await record();
		const pending = deferred<{ text: string }>();
		api.dictationTranscribe.mockReturnValueOnce(pending.promise);
		await act(async () => chunk(new ArrayBuffer(44)));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		discard();
		expect(api.dictationCancel).toHaveBeenCalledTimes(1);
		await act(async () => pending.resolve({ text: "late" }));
		expect(api.dictationCancel).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("textbox", { name: "Editable voice draft" })).not.toBeInTheDocument();
	});
});
