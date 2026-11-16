/**
 * The Documentation tab: project coverage, the chosen file's symbols, the
 * drafts, and the composer that starts each run.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DocFileReport,
	DocProjectOverview,
	DocSymbol,
} from "../../../shared/types/documentation";
import { useDocumentationStore } from "../../stores/documentation-store";
import { useProjectStore } from "../../stores/project-store";
import { coverageTone, DocumentationView, dedent } from "../DocumentationView";

vi.mock("../FilePathAutocomplete", () => ({
	FilePathAutocomplete: (props: {
		value: string;
		onChange: (v: string) => void;
		placeholder?: string;
		disabled?: boolean;
	}) => (
		<input
			aria-label={props.placeholder}
			value={props.value}
			disabled={props.disabled}
			onChange={(e) => props.onChange(e.target.value)}
		/>
	),
}));

const symbol = (over: Partial<DocSymbol>): DocSymbol => ({
	name: "Order",
	symbol_type: "class",
	language: "csharp",
	file_path: "src/Order.cs",
	line_number: 3,
	status: "documented",
	existing_doc: "/// An order",
	generated_doc: "",
	args: [],
	return_type: null,
	...over,
});

const OVERVIEW: DocProjectOverview = {
	total: 10,
	documented: 6,
	partial: 2,
	missing: 2,
	coverage_pct: 60,
	files_scanned: 4,
	files_with_symbols: 3,
	truncated: true,
	languages: [
		{ id: "csharp", label: "C#", files: 2, total: 6, documented: 5, partial: 1, missing: 0, coverage_pct: 83 },
		{ id: "cobol", label: "COBOL", files: 1, total: 4, documented: 1, partial: 1, missing: 2, coverage_pct: 25 },
	],
	files: [
		{ path: "src/Order.cs", language: "csharp", total: 4, documented: 1, partial: 1, missing: 2, coverage_pct: 25 },
	],
};

const FILE: DocFileReport = {
	path: "src/Order.cs",
	language: "csharp",
	total: 2,
	documented: 1,
	partial: 1,
	missing: 0,
	coverage_pct: 50,
	symbols: [
		symbol({}),
		symbol({ name: "Total", symbol_type: "method", line_number: 9, status: "partial", existing_doc: "" }),
	],
};

const run = vi.fn();
const cancel = vi.fn();
const bindProject = vi.fn();

function setStore(state: Partial<ReturnType<typeof useDocumentationStore.getState>>) {
	act(() => useDocumentationStore.setState(state));
}

function renderView(projectId = "p1") {
	return render(<DocumentationView projectId={projectId} />);
}

describe("DocumentationView", () => {
	const writeText = vi.fn();

	beforeEach(() => {
		vi.resetAllMocks();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		useProjectStore.setState({
			projects: [{ id: "p1", name: "Shop", path: "/shop" }] as never,
		});
		useDocumentationStore.setState({
			projectPath: "/shop",
			running: null,
			status: "",
			error: null,
			overview: null,
			file: null,
			drafts: null,
			readme: null,
			selectedSymbol: null,
			draftsView: "docs",
			run,
			cancel,
			bindProject,
		});
	});

	afterEach(() => vi.useRealTimers());

	it("binds the project and offers the first analysis", async () => {
		renderView();

		expect(bindProject).toHaveBeenCalledWith("/shop");
		expect(screen.getByText("Measure the project's documentation")).toBeInTheDocument();
		expect(screen.getByText("Pick a file")).toBeInTheDocument();
		expect(screen.getByText("Nothing proposed yet")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Analyze the project" }));
		expect(run).toHaveBeenCalledWith("project");
	});

	it("says a project is needed and disables the composer without one", () => {
		renderView("unknown");

		expect(bindProject).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent("Select a project first.");
		expect(screen.getByLabelText(/File to check/)).toBeDisabled();
		expect(screen.getByRole("button", { name: "Generate README" })).toBeDisabled();
	});

	it("shows the project overview and opens a file from the priority list", async () => {
		setStore({ overview: OVERVIEW });
		renderView();

		expect(screen.getByText("3 files · 2 languages")).toBeInTheDocument();
		expect(screen.getByText("Needs improvement")).toBeInTheDocument();
		expect(screen.getByText("6/10")).toBeInTheDocument();
		expect(screen.getByText("C#")).toBeInTheDocument();
		expect(screen.getByText("83% · 2")).toBeInTheDocument();
		expect(screen.getByText("Analysis limited to the first 4,000 files.")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /src\/Order\.cs/ }));
		expect(run).toHaveBeenCalledWith("coverage", "src/Order.cs");
		expect(screen.getByLabelText(/File to check/)).toHaveValue("src/Order.cs");

		await userEvent.click(screen.getByRole("button", { name: "Analyze again" }));
		expect(run).toHaveBeenCalledWith("project");
	});

	it.each([
		[90, 0, "Well documented"],
		[20, 0, "Poorly documented"],
	])("rates a %i %% project", (pct, _files, label) => {
		setStore({ overview: { ...OVERVIEW, coverage_pct: pct, languages: [], truncated: false } });
		renderView();
		expect(screen.getByText(label)).toBeInTheDocument();
		expect(screen.queryByText("Languages")).not.toBeInTheDocument();
	});

	it("says when nothing was found and when everything is documented", () => {
		setStore({ overview: { ...OVERVIEW, total: 0, files: [] } });
		const { unmount } = renderView();
		expect(screen.getByText("No symbol found in this project's source files.")).toBeInTheDocument();
		unmount();

		setStore({ overview: { ...OVERVIEW, files: [] } });
		renderView();
		expect(screen.getByText("Everything is documented. Nothing to catch up on.")).toBeInTheDocument();
	});

	it("shows the progress of each run and cancels it", async () => {
		setStore({ running: "project", status: "" });
		const { unmount } = renderView();
		expect(screen.getByText("Reading source files…")).toBeInTheDocument();
		expect(screen.queryByText("Measure the project's documentation")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(cancel).toHaveBeenCalled();
		unmount();

		setStore({ running: "coverage", status: "Reading 2/3" });
		const second = renderView();
		expect(screen.getByText("Reading 2/3")).toBeInTheDocument();
		expect(screen.queryByText("Pick a file")).not.toBeInTheDocument();
		second.unmount();

		setStore({ running: "docstrings", status: "" });
		renderView();
		expect(screen.getByText("Drafting comments…")).toBeInTheDocument();
		expect(screen.queryByText("Nothing proposed yet")).not.toBeInTheDocument();
	});

	it("lists the file's symbols and shows the comment of the one selected", async () => {
		const selectSymbol = vi.fn((key: string | null) =>
			useDocumentationStore.setState({ selectedSymbol: key }),
		);
		setStore({ file: FILE, selectSymbol });
		renderView();

		expect(screen.getByText("50% documented")).toBeInTheDocument();
		expect(screen.getByText("2 symbols")).toBeInTheDocument();
		const total = screen.getByRole("button", { name: /Total/ });
		expect(total).toHaveAttribute("title", "A comment exists but the parameters are not described");
		expect(within(total).getByText("method")).toBeInTheDocument();

		await userEvent.click(total);
		expect(selectSymbol).toHaveBeenLastCalledWith("Total:9");
		expect(screen.getByText("line 9")).toBeInTheDocument();
		expect(screen.getByText("No doc comment above this symbol.")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /Order/ }));
		expect(screen.getByText("/// An order")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /Order/ }));
		expect(selectSymbol).toHaveBeenLastCalledWith(null);
		expect(screen.queryByText("Current comment")).not.toBeInTheDocument();
	});

	it("checks a typed file and proposes its comments", async () => {
		renderView();
		const check = screen.getByRole("button", { name: "Check" });
		expect(check).toBeDisabled();

		fireEvent.change(screen.getByLabelText(/File to check/), {
			target: { value: "  src/Cart.cs " },
		});
		await userEvent.click(check);
		expect(run).toHaveBeenCalledWith("coverage", "src/Cart.cs");
		await userEvent.click(screen.getByRole("button", { name: "Propose comments" }));
		expect(run).toHaveBeenCalledWith("docstrings", "src/Cart.cs");
	});

	it("generates the README of a folder", async () => {
		renderView();
		fireEvent.change(screen.getByLabelText(/Module folder/), {
			target: { value: " src/Orders " },
		});
		await userEvent.click(screen.getByRole("button", { name: "Generate README" }));
		expect(run).toHaveBeenCalledWith("readme", "src/Orders");
	});

	it("follows the file the store has open", () => {
		renderView();
		setStore({ file: FILE });
		expect(screen.getByLabelText(/File to check/)).toHaveValue("src/Order.cs");
	});

	it("shows the drafts and copies one or all of them", async () => {
		const drafts = [
			symbol({ name: "Total", line_number: 9, status: "missing", generated_doc: "    /// Total\n    /// sum" }),
		];
		setStore({
			selectedSymbol: "Total:9",
			drafts: {
				source_path: "src/Order.cs",
				symbols_analyzed: 2,
				symbols_documented: 1,
				symbols_already_documented: 1,
				generated_docs: drafts,
			},
		});
		renderView();

		expect(screen.getByText("1 to complete")).toBeInTheDocument();
		expect(screen.getByText("type · L9")).toBeInTheDocument();
		expect(screen.getByText(/^\/\/\/ Total/)).toHaveTextContent("/// Total /// sum");

		vi.useFakeTimers({ shouldAdvanceTime: true });
		await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
		expect(writeText).toHaveBeenLastCalledWith("Total\n    /// Total\n    /// sum");
		expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
		act(() => vi.advanceTimersByTime(1800));
		expect(screen.getByRole("button", { name: "Copy all" })).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Copy" }));
		expect(writeText).toHaveBeenLastCalledWith("    /// Total\n    /// sum");
	});

	it("says when a file needs no comment", () => {
		setStore({
			drafts: {
				source_path: "src/Order.cs",
				symbols_analyzed: 1,
				symbols_documented: 0,
				symbols_already_documented: 1,
				generated_docs: [],
			},
		});
		renderView();
		expect(screen.getByText("Every symbol in this file is already documented.")).toBeInTheDocument();
	});

	it("switches to the README draft", async () => {
		const setDraftsView = vi.fn((view: "docs" | "readme") =>
			useDocumentationStore.setState({ draftsView: view }),
		);
		setStore({ setDraftsView });
		renderView();

		await userEvent.click(screen.getByRole("button", { name: "README" }));
		expect(screen.getByText("Proposed README")).toBeInTheDocument();
		expect(screen.getByText("Pick a folder below, then “Generate README”.")).toBeInTheDocument();

		setStore({
			readme: { source_path: "src/Orders", readme_content: "# Orders", diagram_content: "" },
		});
		expect(screen.getByText("src/Orders/README.md")).toBeInTheDocument();
		expect(screen.getByText("# Orders")).toBeInTheDocument();

		setStore({ running: "readme" });
		expect(screen.getByText("Drafting the README…")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Comments" }));
		expect(setDraftsView).toHaveBeenLastCalledWith("docs");
	});

	it("shows a failure", () => {
		setStore({ error: "runner crashed" });
		renderView();
		expect(screen.getByRole("alert")).toHaveTextContent("Failed: runner crashed");
	});
});

describe("helpers", () => {
	it("rates a coverage percentage", () => {
		expect(coverageTone(80)).toBe("green");
		expect(coverageTone(50)).toBe("amber");
		expect(coverageTone(49)).toBe("red");
	});

	it("removes the common indentation of a draft", () => {
		expect(dedent("    a\n\n      b")).toBe("a\n\n  b");
		expect(dedent("")).toBe("");
	});
});
