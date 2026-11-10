/** @vitest-environment jsdom */
/**
 * What the notebook page shows beyond its findings (#371), in French: the
 * dependencies between cells, the long cells offered as functions (sent to a
 * review card), and a run in a fresh kernel with its score.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { NotebookExecution, ParsedNotebook } from "../../../../shared/types/notebook-agent";
import { NotebookDetails } from "../NotebookDetails";

const NOTEBOOK: ParsedNotebook = {
	path: "analysis/report.ipynb",
	kernel: "python3",
	language: "python",
	totalCells: 3,
	codeCells: 3,
	markdownCells: 0,
	issues: [],
	cells: [],
	dependencies: {
		edges: [{ from: 2, to: 1, names: ["df"] }],
		order: [0, 2, 1],
		inOrder: false,
		precise: true,
	},
	proposals: [
		{
			cellIndex: 2,
			function: "load_data",
			params: ["path"],
			returns: ["df"],
			lines: 64,
			module: "report_functions.py",
			preview: "",
			reason: "",
		},
		{
			cellIndex: 3,
			function: "plot",
			params: [],
			returns: [],
			lines: 55,
			module: "report_functions.py",
			preview: "",
			reason: "uses a magic",
		},
	],
	runnable: true,
	editable: true,
};

const RUN: NotebookExecution = {
	path: "analysis/report.ipynb",
	status: "done",
	detail: "",
	hint: "",
	runner: "jupyter",
	cells: [
		{ cellIndex: 0, status: "ok", seconds: 0.4, error: null, output: { kinds: [], text: "", shape: null } },
		{
			cellIndex: 1,
			status: "error",
			seconds: 0.1,
			error: { name: "NameError", value: "name 'df' is not defined" },
			output: { kinds: ["error"], text: "", shape: null },
		},
	],
	issues: [],
	score: 50,
	matching: 100,
	durationS: 1.2,
	outputTail: "",
};

const api = {
	executeNotebook: vi.fn(),
	refactorNotebook: vi.fn(),
};

beforeEach(async () => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	await i18n.changeLanguage("fr");
});

afterEach(cleanup);

describe("NotebookDetails", () => {
	it("shows the order that respects the dependencies", () => {
		render(<NotebookDetails notebook={NOTEBOOK} projectPath="/p" />);
		expect(screen.getByText("Ordre d'exécution qui respecte les dépendances : 0 → 2 → 1")).toBeInTheDocument();
		expect(screen.getByText("La cellule n°1 utilise df de la cellule n°2")).toBeInTheDocument();
	});

	it("sends only the chosen cells to the review card", async () => {
		api.refactorNotebook.mockResolvedValue({ extracted: [], refused: [], cleaned: false, review: null });
		render(<NotebookDetails notebook={NOTEBOOK} projectPath="/p" />);
		const apply = screen.getByRole("button", { name: /Préparer sur une carte de revue/ });
		expect(apply).toBeDisabled();
		expect(screen.getByText(/La cellule n°3 \(55 lignes\) reste telle quelle : uses a magic/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("checkbox", { name: /Cellule n°2 \(64 lignes\)/ }));
		fireEvent.click(apply);
		await waitFor(() =>
			expect(api.refactorNotebook).toHaveBeenCalledWith({
				projectPath: "/p",
				notebook: "analysis/report.ipynb",
				extract: [2],
				clean: false,
			}),
		);
		expect(await screen.findByText("Rien n'a changé : le notebook a déjà cette forme.")).toBeInTheDocument();
	});

	it("runs the notebook and shows its score and the failing cell", async () => {
		api.executeNotebook.mockResolvedValue(RUN);
		render(<NotebookDetails notebook={NOTEBOOK} projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: /Exécuter/ }));
		expect(await screen.findByText("50 %")).toBeInTheDocument();
		expect(screen.getByText("NameError: name 'df' is not defined")).toBeInTheDocument();
		expect(api.executeNotebook).toHaveBeenCalledWith({ projectPath: "/p", notebook: "analysis/report.ipynb" });
	});

	it("says how to install a missing kernel", async () => {
		api.executeNotebook.mockResolvedValue({ ...RUN, status: "no_kernel", detail: "ir", hint: "R -e 'IRkernel::installspec()'" });
		render(<NotebookDetails notebook={NOTEBOOK} projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: /Exécuter/ }));
		expect(await screen.findByText("Aucun noyau pour ce notebook : ir")).toBeInTheDocument();
		expect(screen.getByText("R -e 'IRkernel::installspec()'")).toBeInTheDocument();
	});

	it("offers no refactor for a notebook it does not edit", () => {
		render(<NotebookDetails notebook={{ ...NOTEBOOK, editable: false, runnable: false }} projectPath="/p" />);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});
});
