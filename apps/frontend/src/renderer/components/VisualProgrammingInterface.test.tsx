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
				newArchitecture: "New architecture",
				duplicateArchitecture: "Duplicate architecture",
				architectures: "Architectures",
				closeArchitecture: "Close architecture",
				historyShort: "History",
				historyTitle: "Construction history",
				historyEmpty: "No step recorded yet.",
				deleteArchitectureTitle: "Delete this architecture?",
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
 * The store double, kept in the shape the real store has.
 *
 * The panel reads its documents *and* its run state from there now, and it
 * calls the store both ways — bare for the whole state, with a selector for a
 * single field. A double that answered an object to a selector call would make
 * every test here pass against a component that cannot render in the app.
 *
 * `getState` is part of that shape too: the loader effect reads the active
 * architecture imperatively, precisely so that it does not re-run on every
 * edit the mirror writes back.
 */
const SAVED_BLOCK = {
	id: "1",
	position: { x: 250, y: 5 },
	data: { label: "Saved block" },
	type: "editable",
};

const ARCHITECTURE = {
	id: "arch-1",
	name: "Architecture 1",
	diagramType: "architecture",
	nodes: [SAVED_BLOCK] as unknown[],
	edges: [] as unknown[],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const storeState = {
	architectures: [ARCHITECTURE] as (typeof ARCHITECTURE)[],
	activeArchitectureId: "arch-1" as string | null,
	createArchitecture: vi.fn(),
	duplicateArchitecture: vi.fn(),
	renameArchitecture: vi.fn(),
	deleteArchitecture: vi.fn(),
	setActiveArchitecture: vi.fn(),
	updateArchitecture: vi.fn(),
	historyOpen: false,
	setHistoryOpen: vi.fn(),
	versions: [] as unknown[],
	historyLoading: false,
	historyError: null as string | null,
	pendingRestore: null as unknown,
	consumePendingRestore: vi.fn(() => null),
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
		architectures: [{ ...ARCHITECTURE, nodes: [SAVED_BLOCK], edges: [] }],
		activeArchitectureId: "arch-1",
		historyOpen: false,
		versions: [],
		historyLoading: false,
		historyError: null,
		pendingRestore: null,
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

vi.mock("@/stores/visual-to-code-store", () => {
	const useVisualToCodeStore = (
		selector?: (state: typeof storeState) => unknown,
	) => (selector ? selector(storeState) : storeState);
	useVisualToCodeStore.getState = () => storeState;
	return {
		useVisualToCodeStore,
		selectActiveArchitecture: (state: typeof storeState) =>
			state.architectures.find((a) => a.id === state.activeArchitectureId) ??
			null,
		// The timeline talks to the main process; these tests are about the
		// panel, so they answer without one.
		captureVersion: vi.fn(async () => true),
		loadHistory: vi.fn(async () => undefined),
		restoreVersion: vi.fn(async () => true),
		labelVersion: vi.fn(async () => undefined),
		deleteVersion: vi.fn(async () => undefined),
	};
});

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

	it("opens a new architecture beside the current one, destroying nothing", () => {
		render(<CanvasPanel />);

		fireEvent.click(
			screen.getByRole("button", { name: "New architecture" }),
		);

		// It used to clear the canvas, which is why it had to stop and offer an
		// export first. Documents are independent now: there is nothing to lose
		// and nothing to ask.
		expect(storeState.createArchitecture).toHaveBeenCalled();
		expect(
			screen.queryByText("Export file name"),
		).not.toBeInTheDocument();
	});

	it("lists every architecture as a tab, and marks the active one", () => {
		resetStoreState({
			architectures: [
				{ ...ARCHITECTURE, nodes: [SAVED_BLOCK], edges: [] },
				{ ...ARCHITECTURE, id: "arch-2", name: "Mobile", nodes: [], edges: [] },
			],
		});
		render(<CanvasPanel />);

		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Architecture 1",
			"Mobile",
		]);
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");
	});

	it("switches document when another tab is clicked", () => {
		resetStoreState({
			architectures: [
				{ ...ARCHITECTURE, nodes: [SAVED_BLOCK], edges: [] },
				{ ...ARCHITECTURE, id: "arch-2", name: "Mobile", nodes: [], edges: [] },
			],
		});
		render(<CanvasPanel />);

		fireEvent.click(screen.getByRole("tab", { name: "Mobile" }));

		expect(storeState.setActiveArchitecture).toHaveBeenCalledWith("arch-2");
	});

	it("closes an empty architecture outright, and asks about one with work in it", () => {
		resetStoreState({
			architectures: [
				{ ...ARCHITECTURE, nodes: [SAVED_BLOCK], edges: [] },
				{ ...ARCHITECTURE, id: "arch-2", name: "Empty", nodes: [], edges: [] },
			],
		});
		render(<CanvasPanel />);

		// Nothing on it: closing loses nothing, so it just closes.
		fireEvent.click(
			screen.getByRole("button", { name: "Close architecture — Empty" }),
		);
		expect(storeState.deleteArchitecture).toHaveBeenCalledWith("arch-2");

		// One with blocks on it takes its history with it. That is worth a question.
		storeState.deleteArchitecture.mockClear();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Close architecture — Architecture 1",
			}),
		);
		expect(storeState.deleteArchitecture).not.toHaveBeenCalled();
		expect(
			screen.getByText("Delete this architecture?"),
		).toBeInTheDocument();
	});

	it("writes pending edits into the document when the page is left", async () => {
		const { unmount } = render(<CanvasPanel />);
		storeState.updateArchitecture.mockClear();

		fireEvent.click(screen.getByRole("button", { name: "Add block" }));
		await screen.findByText("2 blocks");

		// Edits are coalesced before reaching the store — a drag emits one per
		// frame — so leaving the page inside that window has to flush rather
		// than drop. This is the property that keeps the coalescing free.
		unmount();

		const writes = storeState.updateArchitecture.mock.calls;
		expect(writes.length).toBeGreaterThan(0);
		const [id, patch] = writes[writes.length - 1];
		expect(id).toBe("arch-1");
		expect((patch as { nodes: unknown[] }).nodes).toHaveLength(2);
	});

	it("shows the construction timeline when it is opened", () => {
		resetStoreState({ historyOpen: true });
		render(<CanvasPanel />);

		expect(screen.getByText("Construction history")).toBeInTheDocument();
		expect(screen.getByText("No step recorded yet.")).toBeInTheDocument();
	});

	it("keeps the timeline shut until it is asked for", () => {
		render(<CanvasPanel />);

		expect(screen.queryByText("Construction history")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "History" }));
		expect(storeState.setHistoryOpen).toHaveBeenCalledWith(true);
	});

	it("renders action buttons", () => {
		render(<CanvasPanel />);
		expect(
			screen.getByRole("button", { name: "New architecture" }),
		).toBeInTheDocument();
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
		resetStoreState({
			architectures: [{ ...ARCHITECTURE, nodes: [], edges: [] }],
		});
		render(<CanvasPanel />);

		expect(screen.getByText("0 blocks")).toBeInTheDocument();
		expect(screen.getByText("The canvas is empty")).toBeInTheDocument();
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
