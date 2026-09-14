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
				generatedCodeTitle: "AI-generated code",
				showGeneratedCode: "Generated code",
				dockWriting: "Writing {{file}}…",
				dockWaiting: "Waiting for the first files…",
				generating: "Generating…",
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

// CodeMirror does not initialise under jsdom (its extension set resolves
// through a module graph pnpm gives us twice). What the dock is asked here is
// which file it shows, not how it highlights it.
vi.mock("./ui/code-editor", () => ({
	CodeEditor: ({ value, filename }: { value: string; filename?: string }) => (
		<pre data-testid="code-editor" data-filename={filename}>
			{value}
		</pre>
	),
}));

/**
 * The store double, kept in the shape the real store has: the panel reads its
 * run state from there now, and a double that answers an object to a selector
 * call would make every one of these tests pass against a component that could
 * not render in the app.
 */
const SAVED_BLOCK = {
	id: "1",
	position: { x: 250, y: 5 },
	data: { label: "Saved block" },
	type: "editable",
};

const storeState = {
	canvasNodes: [SAVED_BLOCK],
	canvasEdges: [] as unknown[],
	canvasDiagramType: "architecture",
	setCanvasNodes: vi.fn(),
	setCanvasEdges: vi.fn(),
	setCanvasDiagramType: vi.fn(),
	phase: "idle" as string,
	error: null as string | null,
	status: "",
	streamedFiles: [] as { filename: string; language: string; content: string }[],
	writingFile: null as string | null,
	codeResult: null as { summary?: string } | null,
	pendingDiagram: null as unknown,
	consumePendingDiagram: vi.fn(() => null),
	dockOpen: false,
	selectedFile: 0,
	setDockOpen: vi.fn(),
	selectFile: vi.fn(),
	startRun: vi.fn(),
	clearRun: vi.fn(),
};

function resetStoreState(overrides: Partial<typeof storeState> = {}) {
	Object.assign(storeState, {
		canvasNodes: [SAVED_BLOCK],
		canvasEdges: [],
		canvasDiagramType: "architecture",
		phase: "idle",
		error: null,
		status: "",
		streamedFiles: [],
		writingFile: null,
		codeResult: null,
		pendingDiagram: null,
		dockOpen: false,
		selectedFile: 0,
		...overrides,
	});
}

vi.mock("@/stores/visual-to-code-store", () => ({
	// Zustand stores are called both ways: bare for the whole state, and with a
	// selector. The panel does both.
	useVisualToCodeStore: (selector?: (state: typeof storeState) => unknown) =>
		selector ? selector(storeState) : storeState,
}));

import { CanvasPanel } from "./visual-to-code/CanvasPanel";

describe("CanvasPanel", () => {
	beforeEach(() => {
		resetStoreState();
		// biome-ignore lint/suspicious/noExplicitAny: test double for the preload bridge
		(globalThis as any).electronAPI = {
			// biome-ignore lint/suspicious/noExplicitAny: test double for the preload bridge
			...(globalThis as any).electronAPI,
			// The panel no longer subscribes to any of these — the window does,
			// in `setupVisualToCodeListeners`. They stay on the double because
			// the bootstrap is what a real window would have called.
			onVisualProgrammingStatus: vi.fn(() => vi.fn()),
			onVisualProgrammingFile: vi.fn(() => vi.fn()),
			onVisualProgrammingWriting: vi.fn(() => vi.fn()),
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


	it("opens empty when nothing is stored, and says what to do next", () => {
		// The canvas used to be seeded with a "New diagram" block: a node that
		// named nothing, had to be deleted before any real architecture could be
		// drawn, and made the empty-state hint below unreachable.
		resetStoreState({ canvasNodes: [] });
		render(<CanvasPanel />);

		expect(screen.getByText("0 blocks")).toBeInTheDocument();
		expect(screen.getByText("The canvas is empty")).toBeInTheDocument();
	});

	it("leaves a brand-new diagram empty too", async () => {
		render(<CanvasPanel />);

		fireEvent.click(screen.getByRole("button", { name: "New diagram" }));

		expect(await screen.findByText("0 blocks")).toBeInTheDocument();
	});

	it("shows the generation in the dock while it runs, not a dialog at the end", () => {
		resetStoreState({
			phase: "generating",
			dockOpen: true,
			writingFile: "src/App.tsx",
			streamedFiles: [
				{ filename: "api/Program.cs", language: "csharp", content: "// x" },
			],
		});
		render(<CanvasPanel />);

		// The file already produced, and the one being written right now.
		expect(screen.getByText("Program.cs")).toBeInTheDocument();
		expect(screen.getByText("Writing App.tsx…")).toBeInTheDocument();
	});

	it("offers a way back to a dock the user closed, and none when it is empty", () => {
		resetStoreState({ dockOpen: false });
		const { unmount } = render(<CanvasPanel />);
		expect(
			screen.queryByRole("button", { name: "Generated code" }),
		).not.toBeInTheDocument();
		unmount();

		resetStoreState({
			dockOpen: false,
			phase: "complete",
			streamedFiles: [
				{ filename: "api/Program.cs", language: "csharp", content: "// x" },
			],
		});
		render(<CanvasPanel />);
		expect(
			screen.getByRole("button", { name: "Generated code" }),
		).toBeInTheDocument();
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
