import type { Edge, Node } from "reactflow";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
	CodeToVisualResult,
	GeneratedFile,
	GenerateCodeResult,
} from "@preload/api/modules/visual-programming-api";
import { debugWarn } from "../../shared/utils/debug-logger";

export type DiagramType = "flowchart" | "architecture" | "mockup";

type ActiveMode = "design-import" | "canvas";

/**
 * The four words `bridgePhaseActivity` understands. `generating` is the
 * running verb, and it is also the label the sidebar badge reads
 * (`navigation:activity.kinds.generating`).
 */
export type VisualToCodePhase = "idle" | "generating" | "complete" | "error";

type RunAction = "generate-code" | "code-to-visual";

interface VisualToCodeState {
	activeMode: ActiveMode;
	setActiveMode: (mode: ActiveMode) => void;

	// ── Canvas (persisted across navigation and restarts) ───────────────
	canvasNodes: Node[];
	canvasEdges: Edge[];
	canvasDiagramType: DiagramType;
	setCanvasNodes: (nodes: Node[]) => void;
	setCanvasEdges: (edges: Edge[]) => void;
	setCanvasDiagramType: (type: DiagramType) => void;

	// ── The AI run (session-scoped: it belongs to the window, not the page) ──
	phase: VisualToCodePhase;
	error: string | null;
	/** The backend's own progress line, e.g. "Generating code…". */
	status: string;
	runningAction: RunAction | null;
	/** Files already complete, in the order the model wrote them. */
	streamedFiles: GeneratedFile[];
	/** The file the model is writing right now, before it is complete. */
	writingFile: string | null;
	/** The parsed answer, once the run finishes. */
	codeResult: GenerateCodeResult | null;
	/**
	 * A diagram the model extracted from source, waiting to be applied.
	 *
	 * The canvas is owned by the component (ReactFlow's own `useNodesState`),
	 * and it mirrors itself into `canvasNodes` on every change — so a listener
	 * writing the canvas directly would be overwritten by the next mirror. It
	 * is parked here instead and the canvas takes it on its next render, which
	 * works whether the page was open when the answer arrived or not.
	 */
	pendingDiagram: CodeToVisualResult | null;
	consumePendingDiagram: () => CodeToVisualResult | null;

	// ── The generated-code dock ─────────────────────────────────────────
	dockOpen: boolean;
	selectedFile: number;
	setDockOpen: (open: boolean) => void;
	selectFile: (index: number) => void;

	startRun: (action: RunAction) => void;
	clearRun: () => void;
}

/** What a fresh run resets, so a second generation never shows the first's files. */
const EMPTY_RUN = {
	error: null,
	status: "",
	streamedFiles: [] as GeneratedFile[],
	writingFile: null,
	codeResult: null,
} as const;

export const useVisualToCodeStore = create<VisualToCodeState>()(
	persist(
		(set, get) => ({
			activeMode: "design-import",
			setActiveMode: (mode) => set({ activeMode: mode }),

			canvasNodes: [],
			canvasEdges: [],
			canvasDiagramType: "architecture",
			setCanvasNodes: (nodes) => set({ canvasNodes: nodes }),
			setCanvasEdges: (edges) => set({ canvasEdges: edges }),
			setCanvasDiagramType: (type) => set({ canvasDiagramType: type }),

			phase: "idle",
			...EMPTY_RUN,
			runningAction: null,
			pendingDiagram: null,
			consumePendingDiagram: () => {
				const pending = get().pendingDiagram;
				if (pending) set({ pendingDiagram: null });
				return pending;
			},

			dockOpen: false,
			selectedFile: 0,
			setDockOpen: (open) => set({ dockOpen: open }),
			selectFile: (index) => set({ selectedFile: index }),

			startRun: (action) =>
				set({
					...EMPTY_RUN,
					phase: "generating",
					runningAction: action,
					selectedFile: 0,
					// The dock is the answer to "is anything happening?", so a code
					// generation opens it at the start rather than at the end. A
					// reverse run has nothing to put in it — its answer is the
					// canvas itself.
					dockOpen: action === "generate-code",
				}),

			clearRun: () =>
				set({ ...EMPTY_RUN, phase: "idle", runningAction: null, selectedFile: 0 }),
		}),
		{
			name: "visual-to-code-canvas",
			partialize: (state) => ({
				canvasNodes: state.canvasNodes,
				canvasEdges: state.canvasEdges,
				canvasDiagramType: state.canvasDiagramType,
			}),
		},
	),
);

/**
 * The window's subscription to the visual-programming backend.
 *
 * It used to live in `CanvasPanel`, in a `useEffect` whose cleanup ran on
 * unmount — and `App.tsx` unmounts the view the moment the user navigates
 * away. The generation itself never stopped (it runs in the main process), but
 * nobody was listening any more: the files, the completion and the failure all
 * fell on the floor, and coming back to the page showed a spinner that would
 * never end. Registered once for the life of the window, the page becomes what
 * it should have been all along — a view onto work the session owns.
 */
export function setupVisualToCodeListeners(): () => void {
	const api = globalThis.electronAPI;
	if (!api?.onVisualProgrammingComplete) {
		debugWarn("[visualToCode] preload bridge missing; listeners not registered");
		return () => {
			// Nothing was registered, so there is nothing to tear down. The
			// bootstrap still calls this, and a missing bridge (a mock, a build
			// without the module) must not take the other listeners with it.
		};
	}

	const offStatus = api.onVisualProgrammingStatus?.((status) => {
		useVisualToCodeStore.setState({ status });
	});

	const offFile = api.onVisualProgrammingFile?.((file) => {
		useVisualToCodeStore.setState((state) => ({
			// The model can name the same file twice; the later one is the one it
			// settled on, and two tabs with one name is not a result anybody can
			// read.
			streamedFiles: [
				...state.streamedFiles.filter((f) => f.filename !== file.filename),
				file,
			],
			writingFile: null,
		}));
	});

	const offWriting = api.onVisualProgrammingWriting?.((filename) => {
		useVisualToCodeStore.setState({ writingFile: filename });
	});

	const offError = api.onVisualProgrammingError?.((error) => {
		useVisualToCodeStore.setState({
			phase: "error",
			error,
			status: "",
			writingFile: null,
			runningAction: null,
			dockOpen: true,
		});
	});

	const offComplete = api.onVisualProgrammingComplete((payload) => {
		if (payload.action === "generate-code") {
			const result = payload.data as GenerateCodeResult;
			const files = Array.isArray(result?.files) ? result.files : [];
			useVisualToCodeStore.setState({
				phase: "complete",
				status: "",
				writingFile: null,
				runningAction: null,
				codeResult: result,
				// The parsed answer wins over what was scraped mid-stream: the
				// stream is a preview of the same text, and a file it could not
				// read is one the final parse still has.
				streamedFiles: files,
				dockOpen: true,
			});
			return;
		}

		useVisualToCodeStore.setState({
			phase: "complete",
			status: "",
			writingFile: null,
			runningAction: null,
			pendingDiagram: payload.data as CodeToVisualResult,
		});
	});

	return () => {
		offStatus?.();
		offFile?.();
		offWriting?.();
		offError?.();
		offComplete?.();
	};
}
