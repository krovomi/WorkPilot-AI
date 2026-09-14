import type { Edge, Node } from "reactflow";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
	CodeToVisualResult,
	GeneratedFile,
	GenerateCodeResult,
} from "@preload/api/modules/visual-programming-api";
import type {
	ArchitectureVersionInput,
	ArchitectureVersionMeta,
} from "../../shared/types/visual-to-code-history";
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

/**
 * One architecture document.
 *
 * The canvas used to be a single diagram living in three loose fields, so
 * starting a second design meant destroying the first. An architecture is now
 * a document with a name and an id — the id being what its history on disk is
 * filed under, which is why it has to survive a rename.
 */
export interface Architecture {
	id: string;
	name: string;
	diagramType: DiagramType;
	nodes: Node[];
	edges: Edge[];
	createdAt: string;
	updatedAt: string;
}

/** What the canvas is waiting to load, after a restore or a tab switch. */
export interface PendingRestore {
	architectureId: string;
	versionId: string;
	nodes: Node[];
	edges: Edge[];
	diagramType: DiagramType;
}

/**
 * Ids are filenames on the other side of the bridge (`<id>.json`), and the
 * main process refuses anything outside `[A-Za-z0-9_-]`. `randomUUID` gives
 * exactly that; the fallback is for the environments that do not expose it
 * (older jsdom, a preload-less test) and keeps the same alphabet.
 */
export function newArchitectureId(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return uuid;
	return `arch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

export function createEmptyArchitecture(name: string): Architecture {
	const timestamp = nowIso();
	return {
		id: newArchitectureId(),
		name,
		diagramType: "architecture",
		nodes: [],
		edges: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

interface VisualToCodeState {
	activeMode: ActiveMode;
	setActiveMode: (mode: ActiveMode) => void;

	// ── The architectures, and which one is on screen ───────────────────
	architectures: Architecture[];
	activeArchitectureId: string | null;
	createArchitecture: (name?: string) => string;
	duplicateArchitecture: (id: string) => string | null;
	renameArchitecture: (id: string, name: string) => void;
	deleteArchitecture: (id: string) => void;
	setActiveArchitecture: (id: string) => void;
	/** The canvas mirroring itself back. Ignored for an id that is not open. */
	updateArchitecture: (
		id: string,
		patch: Partial<Pick<Architecture, "nodes" | "edges" | "diagramType">>,
	) => void;

	// ── The construction history of the active architecture ─────────────
	historyOpen: boolean;
	setHistoryOpen: (open: boolean) => void;
	versions: ArchitectureVersionMeta[];
	historyLoading: boolean;
	historyError: string | null;
	/**
	 * A version the canvas has not taken on yet — the same shape as
	 * `pendingDiagram`, and for the same reason: the canvas owns its nodes
	 * through ReactFlow's own state, so anything written around it is
	 * overwritten by the next mirror.
	 */
	pendingRestore: PendingRestore | null;
	consumePendingRestore: () => PendingRestore | null;

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

/** The name a first architecture is given when there is nothing to migrate. */
export const FIRST_ARCHITECTURE_NAME = "Architecture 1";

export const useVisualToCodeStore = create<VisualToCodeState>()(
	persist(
		(set, get) => ({
			activeMode: "design-import",
			setActiveMode: (mode) => set({ activeMode: mode }),

			architectures: [],
			activeArchitectureId: null,

			createArchitecture: (name) => {
				const existing = get().architectures;
				const architecture = createEmptyArchitecture(
					name?.trim() || `Architecture ${existing.length + 1}`,
				);
				set({
					architectures: [...existing, architecture],
					activeArchitectureId: architecture.id,
					// A new document has no history yet, and showing the previous
					// one's timeline under it would be a lie.
					versions: [],
				});
				return architecture.id;
			},

			duplicateArchitecture: (id) => {
				const source = get().architectures.find((a) => a.id === id);
				if (!source) return null;
				const timestamp = nowIso();
				// A copy is a new document: new id, and therefore its own history
				// from this moment. Sharing the original's timeline would mean two
				// documents writing into one file.
				const copy: Architecture = {
					...source,
					id: newArchitectureId(),
					name: `${source.name} (copie)`,
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				set((state) => ({
					architectures: [...state.architectures, copy],
					activeArchitectureId: copy.id,
					versions: [],
				}));
				return copy.id;
			},

			renameArchitecture: (id, name) => {
				const trimmed = name.trim();
				if (!trimmed) return;
				set((state) => ({
					architectures: state.architectures.map((a) =>
						a.id === id ? { ...a, name: trimmed, updatedAt: nowIso() } : a,
					),
				}));
			},

			deleteArchitecture: (id) => {
				const state = get();
				const remaining = state.architectures.filter((a) => a.id !== id);
				// Closing the last tab leaves an empty one rather than a canvas
				// with no document behind it — there is no state in this editor
				// for "no architecture", and inventing one would mean every
				// consumer handling a null.
				const architectures =
					remaining.length > 0
						? remaining
						: [createEmptyArchitecture(FIRST_ARCHITECTURE_NAME)];
				const activeArchitectureId =
					state.activeArchitectureId === id
						? architectures[0].id
						: state.activeArchitectureId;
				set({
					architectures,
					activeArchitectureId,
					versions: state.activeArchitectureId === id ? [] : state.versions,
				});
				void globalThis.electronAPI?.deleteArchitectureHistory?.(id);
			},

			setActiveArchitecture: (id) => {
				if (get().activeArchitectureId === id) return;
				// The timeline belongs to a document; leaving the previous one's
				// rows up while the new one loads is how a restore lands in the
				// wrong architecture.
				set({ activeArchitectureId: id, versions: [], historyError: null });
			},

			updateArchitecture: (id, patch) =>
				set((state) => ({
					architectures: state.architectures.map((a) =>
						a.id === id ? { ...a, ...patch, updatedAt: nowIso() } : a,
					),
				})),

			historyOpen: false,
			setHistoryOpen: (open) =>
				set(
					open
						? // One right-hand dock at a time: the inspector is already
							// there when a block is selected, and three panels on a
							// laptop leave no canvas to edit.
							{ historyOpen: true, dockOpen: false }
						: { historyOpen: false },
				),
			versions: [],
			historyLoading: false,
			historyError: null,
			pendingRestore: null,
			consumePendingRestore: () => {
				const pending = get().pendingRestore;
				if (pending) set({ pendingRestore: null });
				return pending;
			},

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
			setDockOpen: (open) =>
				set(open ? { dockOpen: true, historyOpen: false } : { dockOpen: false }),
			selectFile: (index) => set({ selectedFile: index }),

			startRun: (action) =>
				set({
					...EMPTY_RUN,
					phase: "generating",
					runningAction: action,
					selectedFile: 0,
					dockOpen: action === "generate-code",
					historyOpen: action === "generate-code" ? false : get().historyOpen,
				}),

			clearRun: () =>
				set({
					...EMPTY_RUN,
					phase: "idle",
					runningAction: null,
					selectedFile: 0,
				}),
		}),
		{
			name: "visual-to-code-canvas",
			version: 2,
			partialize: (state) => ({
				architectures: state.architectures,
				activeArchitectureId: state.activeArchitectureId,
			}),
			/**
			 * Version 1 kept one diagram in three loose fields. Whoever had one
			 * open when they updated must find it where they left it, under a
			 * name, rather than discover the feature by losing their work.
			 */
			migrate: (persisted, version) => {
				const state = (persisted ?? {}) as Record<string, unknown>;
				if (version >= 2) return state;

				const nodes = Array.isArray(state.canvasNodes)
					? (state.canvasNodes as Node[])
					: [];
				const edges = Array.isArray(state.canvasEdges)
					? (state.canvasEdges as Edge[])
					: [];
				const migrated = createEmptyArchitecture(FIRST_ARCHITECTURE_NAME);
				migrated.nodes = nodes;
				migrated.edges = edges;
				if (
					state.canvasDiagramType === "flowchart" ||
					state.canvasDiagramType === "mockup"
				) {
					migrated.diagramType = state.canvasDiagramType;
				}
				return {
					architectures: [migrated],
					activeArchitectureId: migrated.id,
				};
			},
			/**
			 * A window that opens on no document has nothing to render, so the
			 * first one is made here rather than in each consumer. This also
			 * covers a fresh install, where there is nothing to migrate either.
			 */
			onRehydrateStorage: () => (state) => {
				if (!state) return;
				if (state.architectures.length === 0) {
					const first = createEmptyArchitecture(FIRST_ARCHITECTURE_NAME);
					state.architectures = [first];
					state.activeArchitectureId = first.id;
					return;
				}
				const known = new Set(state.architectures.map((a) => a.id));
				if (!state.activeArchitectureId || !known.has(state.activeArchitectureId)) {
					state.activeArchitectureId = state.architectures[0].id;
				}
			},
		},
	),
);

/** The document on screen, or null before rehydration has run. */
export function selectActiveArchitecture(
	state: VisualToCodeState,
): Architecture | null {
	return (
		state.architectures.find((a) => a.id === state.activeArchitectureId) ?? null
	);
}

// ── History, against the main process ─────────────────────────────────

/** Read the timeline of one architecture into the store. */
export async function loadHistory(architectureId: string): Promise<void> {
	const api = globalThis.electronAPI?.listArchitectureVersions;
	if (!api) return;
	useVisualToCodeStore.setState({ historyLoading: true, historyError: null });
	try {
		const result = await api(architectureId);
		// The user may have switched tab while this was in flight; writing the
		// answer now would show one document's timeline under another's name.
		if (useVisualToCodeStore.getState().activeArchitectureId !== architectureId) {
			return;
		}
		useVisualToCodeStore.setState({
			historyLoading: false,
			versions: result?.success ? (result.data ?? []) : [],
			historyError: result?.success ? null : (result?.error ?? "unknown"),
		});
	} catch (error) {
		useVisualToCodeStore.setState({
			historyLoading: false,
			historyError: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Record a construction step. Returns false when nothing was written. */
export async function captureVersion(
	architectureId: string,
	version: ArchitectureVersionInput,
): Promise<boolean> {
	const api = globalThis.electronAPI?.appendArchitectureVersion;
	if (!api) return false;
	try {
		const result = await api(architectureId, version);
		if (!result?.success) return false;
		if (useVisualToCodeStore.getState().activeArchitectureId === architectureId) {
			useVisualToCodeStore.setState({ versions: result.data ?? [] });
		}
		return true;
	} catch (error) {
		// A step that could not be recorded is not a reason to interrupt the
		// editing that produced it; the live document is safe either way.
		debugWarn("[visualToCode] could not record a version:", error);
		return false;
	}
}

/**
 * Put an earlier version back on the canvas.
 *
 * Restoring **appends** rather than rewinds: the versions taken after the one
 * being restored are left exactly where they are, and the restore itself
 * becomes the newest step. Going back to look at Tuesday must not be the act
 * that deletes Wednesday — and an undo of a restore is then just another
 * restore.
 */
export async function restoreVersion(
	architectureId: string,
	versionId: string,
): Promise<boolean> {
	const api = globalThis.electronAPI?.getArchitectureVersion;
	if (!api) return false;
	try {
		const result = await api(architectureId, versionId);
		const version = result?.success ? result.data : null;
		if (!version) return false;
		useVisualToCodeStore.setState({
			pendingRestore: {
				architectureId,
				versionId,
				nodes: (version.nodes ?? []) as Node[],
				edges: (version.edges ?? []) as Edge[],
				diagramType: (version.diagramType as DiagramType) ?? "architecture",
			},
		});
		return true;
	} catch (error) {
		debugWarn("[visualToCode] could not restore a version:", error);
		return false;
	}
}

/** Name a step — which is also what keeps it past the cap. */
export async function labelVersion(
	architectureId: string,
	versionId: string,
	label: string | null,
): Promise<void> {
	const api = globalThis.electronAPI?.labelArchitectureVersion;
	if (!api) return;
	const result = await api(architectureId, versionId, label);
	if (result?.success && useVisualToCodeStore.getState().activeArchitectureId === architectureId) {
		useVisualToCodeStore.setState({ versions: result.data ?? [] });
	}
}

/** Remove one step from the timeline. */
export async function deleteVersion(
	architectureId: string,
	versionId: string,
): Promise<void> {
	const api = globalThis.electronAPI?.deleteArchitectureVersion;
	if (!api) return;
	const result = await api(architectureId, versionId);
	if (result?.success && useVisualToCodeStore.getState().activeArchitectureId === architectureId) {
		useVisualToCodeStore.setState({ versions: result.data ?? [] });
	}
}

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
			historyOpen: false,
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
				historyOpen: false,
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
