/**
 * The "Refactoring" tab: paste or type code, detect smells, ask for
 * refactorings, in the language picked or the one the backend reads.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { RefactoringView } from "../RefactoringView";

const runCodeInsights = vi.fn();

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Answers "languages" with two stacks, and the other actions with `answer`. */
function backend(answer: (request: { action: string; text?: string; language?: string }) => unknown) {
	runCodeInsights.mockImplementation(async (request: { action: string }) =>
		request.action === "languages"
			? { languages: [{ id: "python", label: "Python" }, { id: "go", label: "Go" }] }
			: answer(request),
	);
}

const sourceBox = () => screen.getByRole("textbox");
const detect = () => screen.getByRole("button", { name: "Detect Code Smells" });
const propose = () => screen.getByRole("button", { name: "Propose Refactoring" });

describe("RefactoringView", () => {
	beforeAll(() => {
		Element.prototype.hasPointerCapture = vi.fn(() => false);
		Element.prototype.releasePointerCapture = vi.fn();
	});

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		runCodeInsights.mockReset();
		Object.assign(globalThis.electronAPI, { runCodeInsights });
	});

	it("waits for code before offering the actions", async () => {
		backend(() => ({}));
		render(<RefactoringView />);
		expect(screen.getByRole("heading", { name: "Source code" })).toBeInTheDocument();
		expect(sourceBox()).toHaveAttribute("placeholder", "Paste source code here to analyze...");
		expect(screen.getByText("No smells yet")).toBeInTheDocument();
		expect(screen.getByText("No proposals")).toBeInTheDocument();
		expect(detect()).toBeDisabled();
		expect(propose()).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

		await userEvent.type(sourceBox(), "   ");
		expect(detect()).toBeDisabled();
		await waitFor(() => expect(runCodeInsights).toHaveBeenCalledWith({ action: "languages" }));
	});

	it("lists the smells by severity and opens one to read its measure", async () => {
		backend(() => ({
			language: "python",
			smells: [
				{
					smell_type: "long_function",
					severity: "HIGH",
					message: "Function is 120 lines long",
					line: 4,
					symbol: "handle",
					metric_value: 120,
					threshold: 50,
				},
				{ smell_type: "deep_nesting", severity: "high", message: "Five levels deep", line: 9, symbol: "loop" },
				{ smell_type: "magic_number", severity: "", message: "Bare 42" },
				{ smell_type: "odd", severity: "weird", message: "Unknown kind" },
			],
		}));
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "def handle(): pass");
		await userEvent.click(detect());

		expect(await screen.findByRole("heading", { name: "Code Smells (4)" })).toBeInTheDocument();
		expect(runCodeInsights).toHaveBeenCalledWith({ action: "smells", text: "def handle(): pass", language: undefined });
		// The language the backend read the code as.
		expect(screen.getByText("Read as Python")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Python source code" })).toBeInTheDocument();
		expect(screen.getByText("High · 2")).toBeInTheDocument();
		expect(screen.getByText("Info · 1")).toBeInTheDocument();
		expect(screen.getByText("weird · 1")).toBeInTheDocument();
		expect(screen.getByText("long function")).toBeInTheDocument();
		expect(screen.getByText("L4")).toBeInTheDocument();
		expect(screen.getAllByText("—")).toHaveLength(2);

		const card = screen.getByRole("button", { name: /long function/ });
		expect(card).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByText("Function is 120 lines long")).toBeNull();
		await userEvent.click(card);
		expect(card).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Function is 120 lines long")).toBeInTheDocument();
		expect(card).toHaveTextContent("Measured: 120 · Threshold: 50");

		// A smell without a measure shows its message only.
		await userEvent.click(screen.getByRole("button", { name: /deep nesting/ }));
		expect(screen.getByText("Five levels deep").parentElement).not.toHaveTextContent("Measured:");

		await userEvent.click(card);
		expect(screen.queryByText("Function is 120 lines long")).toBeNull();
	});

	it("says when the code is clean", async () => {
		backend(() => ({ language: "go", smells: [] }));
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "package main");
		await userEvent.click(detect());
		expect(await screen.findByText("No smell found in this code.")).toBeInTheDocument();
		expect(screen.queryByText("No smells yet")).toBeNull();
	});

	it("shows the scan while the smells are detected", async () => {
		const answer = deferred<unknown>();
		backend(() => answer.promise);
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "x = 1");
		await userEvent.click(detect());

		expect(screen.getByRole("status")).toHaveTextContent("Detecting...");
		expect(screen.getByRole("button", { name: "Detecting..." })).toBeDisabled();
		expect(propose()).toBeDisabled();
		await act(async () => answer.resolve({ language: "python", smells: [] }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("lists the proposed refactorings with their risk", async () => {
		const answer = deferred<unknown>();
		backend(() => answer.promise);
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "x = 1");
		await userEvent.click(propose());
		expect(screen.getByRole("status")).toHaveTextContent("Generating...");
		expect(screen.getByRole("button", { name: "Generating..." })).toBeDisabled();

		await act(async () =>
			answer.resolve({
				language: "python",
				proposals: [
					{ pattern: "extract_method", description: "Split handle()", risk_level: "MEDIUM", symbol: "handle", impact: "Shorter functions" },
					{ pattern: "rename", description: "Rename x", risk_level: "", symbol: null, impact: null },
					{ pattern: "inline", description: "Inline y", risk_level: "extreme" },
				],
			}),
		);
		expect(screen.getByRole("heading", { name: "Refactoring Proposals (3)" })).toBeInTheDocument();
		expect(runCodeInsights).toHaveBeenCalledWith({ action: "propose", text: "x = 1", language: undefined });
		expect(screen.getByText("extract method")).toBeInTheDocument();
		expect(screen.getByText("Split handle()")).toBeInTheDocument();
		expect(screen.getByText("Risk medium")).toBeInTheDocument();
		expect(screen.getByText("Impact · Shorter functions")).toBeInTheDocument();
		expect(screen.getByText("Risk low")).toBeInTheDocument();
		expect(screen.getByText("Risk extreme")).toBeInTheDocument();
		expect(screen.getByText("Read as Python")).toBeInTheDocument();
	});

	it("sends the language picked, and stops guessing it", async () => {
		backend(() => ({ language: "go", smells: [], proposals: [] }));
		render(<RefactoringView />);
		const picker = screen.getByRole("combobox", { name: "Language" });
		await waitFor(() => expect(runCodeInsights).toHaveBeenCalledTimes(1));
		fireEvent.keyDown(picker, { key: "Enter" });
		expect(await screen.findByRole("option", { name: "Auto-detect" })).toBeInTheDocument();
		await userEvent.click(await screen.findByRole("option", { name: "Go" }));

		expect(screen.getByRole("heading", { name: "Go source code" })).toBeInTheDocument();
		expect(sourceBox()).toHaveAttribute("placeholder", "Paste Go source code here to analyze...");
		await userEvent.type(sourceBox(), "package main");
		await userEvent.click(detect());
		await waitFor(() =>
			expect(runCodeInsights).toHaveBeenCalledWith({ action: "smells", text: "package main", language: "go" }),
		);
		await waitFor(() => expect(detect()).not.toBeDisabled());
		await userEvent.click(propose());
		await waitFor(() =>
			expect(runCodeInsights).toHaveBeenCalledWith({ action: "propose", text: "package main", language: "go" }),
		);
		// No "read as" chip once a language is chosen.
		expect(screen.queryByText(/^Read as/)).toBeNull();
	});

	it("shows an id the language list does not know as it is", async () => {
		backend(() => ({ language: "cobol", smells: [] }));
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "MOVE A TO B");
		await userEvent.click(detect());
		expect(await screen.findByText("Read as cobol")).toBeInTheDocument();
	});

	it("keeps working on auto-detect when the language list cannot be read", async () => {
		runCodeInsights.mockRejectedValueOnce(new Error("no backend"));
		render(<RefactoringView />);
		await waitFor(() => expect(runCodeInsights).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("combobox", { name: "Language" })).toHaveTextContent("Auto-detect");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("ignores a language list that arrives after the tab was left", async () => {
		const answer = deferred<unknown>();
		runCodeInsights.mockReturnValueOnce(answer.promise);
		const { unmount } = render(<RefactoringView />);
		unmount();
		await act(async () => answer.resolve({ languages: [{ id: "go", label: "Go" }] }));
		expect(runCodeInsights).toHaveBeenCalledTimes(1);
	});

	it("says why a detection or a proposal failed", async () => {
		const failures = [new Error("Runner crashed"), "boom", new Error("Timeout"), new Error("")];
		backend(() => Promise.reject(failures.shift()));
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "x");

		await userEvent.click(detect());
		expect(await screen.findByRole("alert")).toHaveTextContent("Runner crashed");
		await userEvent.click(detect());
		expect(await screen.findByText("Detection failed")).toBeInTheDocument();
		await userEvent.click(propose());
		expect(await screen.findByText("Timeout")).toBeInTheDocument();
		await userEvent.click(propose());
		expect(await screen.findByText("Proposal generation failed")).toBeInTheDocument();
	});

	it("pastes the clipboard over the previous code and its results", async () => {
		backend(() => ({ language: "python", smells: [{ smell_type: "long_function", severity: "low", message: "m" }] }));
		const readText = vi.fn().mockResolvedValue("print('pasted')");
		Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "old");
		await userEvent.click(detect());
		expect(await screen.findByText("Low · 1")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Paste" }));
		await waitFor(() => expect(sourceBox()).toHaveValue("print('pasted')"));
		expect(screen.queryByText("Low · 1")).toBeNull();
		expect(screen.getByText("No smells yet")).toBeInTheDocument();
	});

	it("says when the clipboard cannot be read", async () => {
		backend(() => ({}));
		Object.defineProperty(navigator, "clipboard", {
			value: { readText: vi.fn().mockRejectedValue(new Error("denied")) },
			configurable: true,
		});
		render(<RefactoringView />);
		await userEvent.click(screen.getByRole("button", { name: "Paste" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The clipboard could not be read. Paste the code into the field instead.",
		);
	});

	it("clears the code, the results and the error", async () => {
		backend(() => Promise.reject(new Error("Runner crashed")));
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "x");
		await userEvent.click(detect());
		expect(await screen.findByRole("alert")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(sourceBox()).toHaveValue("");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
	});

	it("drops an answer for code that was cleared while it ran", async () => {
		const smells = deferred<unknown>();
		const proposals = deferred<unknown>();
		backend((request) => (request.action === "smells" ? smells.promise : proposals.promise));
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "old code");
		await userEvent.click(detect());
		await userEvent.click(screen.getByRole("button", { name: "Clear" }));

		await act(async () =>
			smells.resolve({ language: "python", smells: [{ smell_type: "long_function", severity: "high", message: "m" }] }),
		);
		expect(screen.getByRole("heading", { name: "Code Smells (0)" })).toBeInTheDocument();
		expect(screen.queryByText("No smell found in this code.")).toBeNull();
		expect(screen.queryByText(/^Read as/)).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();

		await userEvent.type(sourceBox(), "old code");
		await userEvent.click(propose());
		await userEvent.click(screen.getByRole("button", { name: "Clear" }));
		await act(async () =>
			proposals.resolve({ language: "python", proposals: [{ pattern: "rename", description: "Rename", risk_level: "low" }] }),
		);
		expect(screen.getByRole("heading", { name: "Refactoring Proposals (0)" })).toBeInTheDocument();
	});

	it("drops a failure for code that was cleared while it ran", async () => {
		const smells = deferred<unknown>();
		const proposals = deferred<unknown>();
		backend((request) => (request.action === "smells" ? smells.promise : proposals.promise));
		render(<RefactoringView />);
		await userEvent.type(sourceBox(), "old code");
		await userEvent.click(detect());
		await userEvent.click(screen.getByRole("button", { name: "Clear" }));
		await act(async () => smells.reject(new Error("Runner crashed")));
		expect(screen.queryByRole("alert")).toBeNull();

		await userEvent.type(sourceBox(), "old code");
		await userEvent.click(propose());
		await userEvent.click(screen.getByRole("button", { name: "Clear" }));
		await act(async () => proposals.reject(new Error("Runner crashed")));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
