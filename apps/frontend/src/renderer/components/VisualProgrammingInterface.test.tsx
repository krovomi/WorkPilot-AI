import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (
			key: string,
			fallback?: string | Record<string, unknown>,
			options?: Record<string, unknown>,
		) => {
			const translations: Record<string, string> = {
				newDiagram: "New diagram",
				addBlock: "Add block",
				reverse: "Reverse: Code → Visual",
				scaffold: "Generate project",
				codePreview: "Code preview",
				export: "Export JSON",
				saveAs: "Save as…",
				load: "Load",
				palette: "Palette",
				chooseFramework: "Choose framework or language",
				chooseFileName: "Export file name",
				diagramType: "Diagram type",
				undo: "Undo",
				redo: "Redo",
				autoLayout: "Auto-arrange",
				statusBlocks: "{{count}} blocks",
				statusConnections: "{{count}} connections",
				statusUnsaved: "Unsaved",
				statusSaved: "Saved",
				emptyCanvasTitle: "The canvas is empty",
				searchBlocks: "Search a block…",
			};
			const opts =
				typeof fallback === "object" && fallback !== null ? fallback : options;
			const raw =
				translations[key] ??
				(typeof fallback === "string" ? fallback : undefined) ??
				key;
			// The real `t` interpolates; the counts in the status bar are the
			// whole point of asserting on it.
			return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
				String(opts?.[name] ?? ""),
			);
		},
		i18n: { language: "en", changeLanguage: vi.fn() },
	}),
}));

// Partial mock: only the pieces that need a real canvas are stubbed. The hooks,
// `addEdge`, `MarkerType` and the path helpers stay real, so the panel's own
// state machine — add, undo, dirty tracking — is what these tests exercise.
// The previous hand-rolled mock replaced the whole module, so every ReactFlow
// export the panel started using broke the suite with "No X export is defined".
vi.mock("reactflow", async (importOriginal) => {
	const actual = await importOriginal<typeof import("reactflow")>();
	const React = await import("react");
	return {
		...actual,
		default: React.forwardRef<
			HTMLDivElement,
			React.HTMLAttributes<HTMLDivElement>
		>(({ children, onDrop, onDragOver }, ref) =>
			React.createElement(
				"div",
				{ ref, "data-testid": "reactflow-canvas", onDrop, onDragOver },
				children,
			),
		),
		MiniMap: () => null,
		Controls: () => null,
		Background: () => null,
	};
});

vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

vi.mock("@/stores/visual-to-code-store", () => ({
	useVisualToCodeStore: () => ({
		canvasNodes: [
			{
				id: "1",
				position: { x: 250, y: 5 },
				data: { label: "New diagram" },
				type: "editable",
			},
		],
		canvasEdges: [],
		canvasDiagramType: "architecture",
		setCanvasNodes: () => {
			// Mock function for testing
		},
		setCanvasEdges: () => {
			// Mock function for testing
		},
		setCanvasDiagramType: () => {
			// Mock function for testing
		},
	}),
}));

import { CanvasPanel } from "./visual-to-code/CanvasPanel";

describe("CanvasPanel", () => {
	beforeEach(() => {
		// biome-ignore lint/suspicious/noExplicitAny: test double for the preload bridge
		(globalThis as any).electronAPI = {
			// biome-ignore lint/suspicious/noExplicitAny: test double for the preload bridge
			...(globalThis as any).electronAPI,
			onVisualProgrammingStatus: vi.fn(() => vi.fn()),
			onVisualProgrammingError: vi.fn(() => vi.fn()),
			onVisualProgrammingComplete: vi.fn(() => vi.fn()),
			runVisualProgramming: vi.fn().mockResolvedValue({ success: true }),
			saveJsonFile: vi.fn().mockResolvedValue({ success: true }),
			getUserHome: vi.fn().mockResolvedValue("/home/user"),
		};
		// biome-ignore lint/suspicious/noExplicitAny: test double for the platform bridge
		(globalThis as any).platform = { isWindows: false };
	});

	it("renders a single 'New diagram' button (consolidated types)", () => {
		render(<CanvasPanel />);
		expect(
			screen.getByRole("button", { name: "New diagram" }),
		).toBeInTheDocument();
	});

	it("renders action buttons", () => {
		render(<CanvasPanel />);
		expect(screen.getByText("Add block")).toBeInTheDocument();
		expect(screen.getByText("Reverse: Code → Visual")).toBeInTheDocument();
		// Primary action: full agentic scaffold; secondary: one-shot code preview
		expect(screen.getByText("Generate project")).toBeInTheDocument();
		expect(screen.getByText("Code preview")).toBeInTheDocument();
		expect(screen.getByText("Export JSON")).toBeInTheDocument();
		expect(screen.getByText("Save as…")).toBeInTheDocument();
		expect(screen.getByText("Load")).toBeInTheDocument();
	});

	it("renders the ReactFlow canvas", () => {
		render(<CanvasPanel />);
		expect(screen.getByTestId("reactflow-canvas")).toBeInTheDocument();
	});

	it("Generate-project and Code-preview buttons are enabled when diagram has nodes", () => {
		render(<CanvasPanel />);
		expect(
			screen.getByRole("button", { name: "Generate project" }),
		).not.toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Code preview" }),
		).not.toBeDisabled();
	});

	it("exposes every diagram type — flowchart and mockup were unreachable before", () => {
		render(<CanvasPanel />);
		const select = screen.getByLabelText("Diagram type") as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toEqual([
			"architecture",
			"flowchart",
			"mockup",
		]);
	});

	it("reports the diagram size in the status bar", () => {
		render(<CanvasPanel />);
		expect(screen.getByText("1 blocks")).toBeInTheDocument();
		expect(screen.getByText("0 connections")).toBeInTheDocument();
	});

	it("starts clean, and marks the diagram unsaved once a block is added", async () => {
		render(<CanvasPanel />);
		expect(screen.getByText("Saved")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Add block" }));
		expect(await screen.findByText("2 blocks")).toBeInTheDocument();
		expect(screen.getByText("Unsaved")).toBeInTheDocument();
	});

	it("undoes an added block, and ignores Ctrl+Z typed into a field", async () => {
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Add block" }));
		expect(await screen.findByText("2 blocks")).toBeInTheDocument();

		// The undo button only lights up once the debounced commit has run.
		const undoButton = screen.getByRole("button", { name: "Undo" });
		await waitFor(() => expect(undoButton).not.toBeDisabled(), {
			timeout: 2000,
		});

		// A shortcut typed into a text field belongs to the field. The window
		// listener used to fire regardless, so Backspace in the filename input
		// deleted the canvas selection.
		const search = screen.getByLabelText("Search a block…");
		fireEvent.keyDown(search, { key: "z", ctrlKey: true });
		expect(screen.getByText("2 blocks")).toBeInTheDocument();

		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(await screen.findByText("1 blocks")).toBeInTheDocument();
	});

	it("filters the palette by translated label", () => {
		render(<CanvasPanel />);
		expect(screen.getByText("database")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search a block…"), {
			target: { value: "database" },
		});
		expect(screen.getByText("database")).toBeInTheDocument();
		expect(screen.queryByText("frontend")).not.toBeInTheDocument();
	});

	it("opens the scaffold-target dialog without an infinite update loop", async () => {
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Generate project" }));
		// A Radix Presence ref loop would throw "Maximum update depth exceeded"
		// here; otherwise the dialog title renders.
		expect(
			await screen.findByText("Où générer le projet ?"),
		).toBeInTheDocument();
	});

	it("opens the Save-As dialog without an update loop", async () => {
		// Force the millisecond timestamp to advance on every read. The old
		// filename effect (deps included the unstable getDefaultFileName) re-ran
		// on every render and wrote a new value each time → "Maximum update
		// depth exceeded". The fix computes it only when the dialog opens.
		let tick = 0;
		const RealDate = Date;
		vi.stubGlobal(
			"Date",
			class extends RealDate {
				getMilliseconds() {
					return tick++ % 1000;
				}
				// biome-ignore lint/suspicious/noExplicitAny: constructor passthrough
			} as any,
		);
		try {
			render(<CanvasPanel />);
			fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
			expect(await screen.findByText("Export file name")).toBeInTheDocument();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("opens the scaffold dialog with an active project seeded (no loop)", async () => {
		const { useProjectStore } = await import("../stores/project-store");
		useProjectStore.setState({
			// biome-ignore lint/suspicious/noExplicitAny: minimal test project
			projects: [{ id: "p1", name: "My Project" } as any],
			activeProjectId: "p1",
		});
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Generate project" }));
		expect(await screen.findByText("My Project")).toBeInTheDocument();
		useProjectStore.setState({ projects: [], activeProjectId: null });
	});
});
