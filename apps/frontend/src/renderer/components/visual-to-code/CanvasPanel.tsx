/**
 * CanvasPanel
 * Interactive visual programming canvas (no-code/low-code).
 * - Draw an architecture → hand it to the agentic build pipeline
 * - Draw an architecture → one-shot code preview
 * - Reverse: a source file → the diagram it implies
 *
 * The canvas owns the diagram. Nodes and edges in state are *plain data* —
 * no callbacks — and the versions handed to ReactFlow are derived, with the
 * handlers injected at render. That split is what fixes the renames and edge
 * labels that used to be shown but never saved: there is one owner of a
 * label now, and it is the array that gets exported, persisted and turned
 * into the build spec.
 */

import {
	ArrowLeftRight,
	Blocks,
	FileJson,
	FilePlus2,
	FolderOpen,
	Loader2,
	LayoutGrid,
	MousePointerSquareDashed,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
	Redo2,
	Rocket,
	Save,
	Sparkles,
	Trash2,
	Undo2,
} from "lucide-react";
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import ReactFlow, {
	addEdge,
	Background,
	BackgroundVariant,
	type Connection,
	Controls,
	type Edge,
	MarkerType,
	MiniMap,
	type Node,
	useEdgesState,
	useNodesState,
} from "reactflow";
import { Button } from "../ui/button";
import "reactflow/dist/style.css";
import type {
	CodeToVisualResult,
	GenerateCodeResult,
} from "@preload/api/modules/visual-programming-api";
import { saveAs } from "file-saver";
import { toast } from "@/hooks/use-toast";
import {
	blockAccent,
	blockMeta,
	FRAMEWORKS_BY_TYPE,
	needsFramework,
} from "../../lib/architecture-blocks";
import {
	canConnect,
	connectionLabel,
	type Lang,
} from "../../lib/architecture-connections";
import {
	buildArchitectureSpec,
	sanitizeEdges,
} from "../../lib/architecture-spec";
import {
	canRedo,
	canUndo,
	commit as commitHistory,
	initHistory,
	redo as redoHistory,
	signature,
	undo as undoHistory,
} from "../../lib/canvas-history";
import { autoLayout } from "../../lib/canvas-layout";
import {
	addProject as registerProject,
	useProjectStore,
} from "../../stores/project-store";
import { createTask } from "../../stores/task-store";
import type { DiagramType } from "../../stores/visual-to-code-store";
import { useVisualToCodeStore } from "../../stores/visual-to-code-store";
import { FileTree } from "../FileTree";
import { VisualProgrammingPalette } from "../VisualProgrammingPalette";
import { edgeTypes, nodeTypes } from "../reactflowTypes";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "../ui/dialog";

export type { DiagramType } from "../../stores/visual-to-code-store";

const DIAGRAM_TYPES: DiagramType[] = ["architecture", "flowchart", "mockup"];

/** What the Save-As dialog should do once the file is written. */
type PendingAfterSave = "new-diagram" | null;

// Collision-free node ids. The previous `(nodes.length + 1)` scheme reused ids
// after a delete (e.g. delete "1" then add → "2" again), which left edges
// pointing at the wrong / a now-missing node (the dangling `edge-1-6`). Module
// scope so the callbacks that mint ids stay referentially stable.
const genNodeId = () =>
	globalThis.crypto?.randomUUID?.() ??
	`n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const CanvasPanel: React.FC = () => {
	const { t, i18n } = useTranslation("visualProgramming");
	const lang: Lang = i18n.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
	// Captured imperatively when the scaffold dialog opens — NOT a reactive
	// store subscription. Subscribing here would re-render the canvas on every
	// project-store change (e.g. task-progress updates while the panel stays
	// mounted), which can thrash Radix Presence refs into a "Maximum update
	// depth exceeded" loop.
	const [activeProject, setActiveProject] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const {
		canvasNodes: storedNodes,
		canvasEdges: storedEdges,
		canvasDiagramType: storedDiagramType,
		setCanvasNodes,
		setCanvasEdges,
		setCanvasDiagramType,
	} = useVisualToCodeStore();

	const [nodes, setNodes, onNodesChange] = useNodesState(
		storedNodes.length > 0
			? storedNodes
			: [
					{
						id: "1",
						position: { x: 120, y: 80 },
						data: { label: t("newDiagram", "Nouveau diagramme") },
						type: "editable",
					},
				],
	);
	const [edges, setEdges, onEdgesChange] = useEdgesState(storedEdges);
	const [diagramType, setDiagramType] =
		useState<DiagramType>(storedDiagramType);
	const loadInputRef = useRef<HTMLInputElement>(null);
	const [showFrameworkModal, setShowFrameworkModal] = useState(false);
	const [pendingNode, setPendingNode] = useState<{
		id: string;
		type: string;
		position: { x: number; y: number };
	} | null>(null);
	const [customFramework, setCustomFramework] = useState("");
	// biome-ignore lint/suspicious/noExplicitAny: ReactFlow instance has no exported type in v11
	const reactFlowRef = useRef<any>(null);
	const [showPalette, setShowPalette] = useState(true);
	// MiniMap is collapsed to a small thumbnail and expands on hover.
	const [miniMapExpanded, setMiniMapExpanded] = useState(false);
	const [selectedFolder, setSelectedFolder] = useState<string>("");
	const [showSaveAsDialog, setShowSaveAsDialog] = useState(false);
	const [saveAsFileName, setSaveAsFileName] = useState("");
	const [pendingAfterSave, setPendingAfterSave] =
		useState<PendingAfterSave>(null);

	// ── Dirty tracking ──────────────────────────────────────────────────
	// Derived from a content signature rather than flipped on every ReactFlow
	// change: selecting a node used to mark the diagram unsaved, so the
	// "unsaved" dot was on permanently and meant nothing.
	const currentSignature = useMemo(
		() => signature({ nodes, edges }),
		[nodes, edges],
	);
	const [savedSignature, setSavedSignature] = useState(currentSignature);
	const isDirty = currentSignature !== savedSignature;

	// ── Undo / redo ─────────────────────────────────────────────────────
	const historyRef = useRef(initHistory({ nodes, edges }));
	const [historyTick, setHistoryTick] = useState(0);
	useEffect(() => {
		// Debounced: a drag emits a position change per frame, and committing
		// each one would bury the previous real state under a hundred entries.
		const timer = setTimeout(() => {
			const next = commitHistory(historyRef.current, { nodes, edges });
			if (next !== historyRef.current) {
				historyRef.current = next;
				setHistoryTick((v) => v + 1);
			}
		}, 350);
		return () => clearTimeout(timer);
	}, [nodes, edges]);

	const applySnapshot = useCallback(
		(snapshot: { nodes: Node[]; edges: Edge[] }) => {
			setNodes(snapshot.nodes);
			setEdges(snapshot.edges);
		},
		[setEdges, setNodes],
	);

	const handleUndo = useCallback(() => {
		if (!canUndo(historyRef.current)) return;
		historyRef.current = undoHistory(historyRef.current);
		applySnapshot(historyRef.current.present);
		setHistoryTick((v) => v + 1);
	}, [applySnapshot]);

	const handleRedo = useCallback(() => {
		if (!canRedo(historyRef.current)) return;
		historyRef.current = redoHistory(historyRef.current);
		applySnapshot(historyRef.current.present);
		setHistoryTick((v) => v + 1);
	}, [applySnapshot]);

	// Read during render, not memoised: the stack lives in a ref (it must not
	// re-render the canvas on every commit), so `historyTick` is what schedules
	// the render and these two just read the current value once it happens.
	void historyTick;
	const undoAvailable = canUndo(historyRef.current);
	const redoAvailable = canRedo(historyRef.current);

	// ── AI generation state ─────────────────────────────────────────────
	const [isAiRunning, setIsAiRunning] = useState(false);
	const [aiStatus, setAiStatus] = useState("");
	const [showCodeResult, setShowCodeResult] = useState(false);
	const [codeResult, setCodeResult] = useState<GenerateCodeResult | null>(null);
	const [selectedCodeFile, setSelectedCodeFile] = useState(0);
	const codeToVisualInputRef = useRef<HTMLInputElement>(null);

	// ── Node / edge mutation ────────────────────────────────────────────
	const handleRenameNode = useCallback(
		(id: string, newLabel: string) => {
			setNodes((nds) =>
				nds.map((n) =>
					n.id === id ? { ...n, data: { ...n.data, label: newLabel } } : n,
				),
			);
		},
		[setNodes],
	);

	const handleDeleteNode = useCallback(
		(id: string) => {
			setNodes((nds) => nds.filter((n) => n.id !== id));
			// Drop the edges that pointed at it in the same beat. Leaving them
			// behind is what produced the dangling `edge-1-6` the spec builder
			// had to defend against.
			setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
		},
		[setEdges, setNodes],
	);

	const handleEdgeLabelChange = useCallback(
		(id: string, newLabel: string) => {
			setEdges((eds) =>
				eds.map((e) =>
					e.id === id ? { ...e, data: { ...e.data, label: newLabel } } : e,
				),
			);
		},
		[setEdges],
	);

	const handleDeleteEdge = useCallback(
		(id: string) => setEdges((eds) => eds.filter((e) => e.id !== id)),
		[setEdges],
	);

	const handleSetFramework = useCallback(
		(id: string, framework: string) => {
			setNodes((nds) =>
				nds.map((n) =>
					n.id === id ? { ...n, data: { ...n.data, framework } } : n,
				),
			);
		},
		[setNodes],
	);

	// The arrays ReactFlow actually renders: state data plus the handlers. Kept
	// out of state so what we persist and export stays serialisable.
	const renderNodes = useMemo(
		() =>
			nodes.map((n) => ({
				...n,
				data: {
					...n.data,
					onRename: handleRenameNode,
					onDelete: handleDeleteNode,
				},
			})),
		[nodes, handleRenameNode, handleDeleteNode],
	);

	const renderEdges = useMemo(
		() =>
			edges.map((e) => ({
				...e,
				markerEnd: e.markerEnd ?? {
					type: MarkerType.ArrowClosed,
					width: 18,
					height: 18,
				},
				data: {
					...e.data,
					onEdgeLabelChange: handleEdgeLabelChange,
					onDelete: handleDeleteEdge,
				},
			})),
		[edges, handleEdgeLabelChange, handleDeleteEdge],
	);

	const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);
	const inspected = selectedNodes.length === 1 ? selectedNodes[0] : null;

	// Extracted event handlers to reduce nesting
	const handleVisualProgrammingStatus = useCallback((msg: string) => {
		setAiStatus(msg);
	}, []);

	const handleVisualProgrammingError = useCallback(
		(err: string) => {
			setIsAiRunning(false);
			setAiStatus("");
			toast({
				title: t("aiError", "Erreur IA"),
				description: err,
				variant: "destructive",
			});
		},
		[t],
	);

	const handleVisualProgrammingComplete = useCallback(
		(payload: {
			action: string;
			data: GenerateCodeResult | CodeToVisualResult;
		}) => {
			setIsAiRunning(false);
			setAiStatus("");
			if (payload.action === "generate-code") {
				const result = payload.data as GenerateCodeResult;
				setCodeResult(result);
				setSelectedCodeFile(0);
				setShowCodeResult(true);
				toast({
					title: t("codeGenerated", "Code généré !"),
					description: result.summary,
				});
			} else if (payload.action === "code-to-visual") {
				const result = payload.data as CodeToVisualResult;
				// The model's own node ids are the ones its edges reference. Minting
				// a replacement id for a node that came back without one used to
				// orphan every edge that named it, so the import produced a pile of
				// disconnected boxes.
				const idFor = new Map<number, string>();
				const newNodes = result.nodes.map((n, i) => {
					const id = n.id?.trim() || `imported-${i}`;
					idFor.set(i, id);
					return {
						id,
						position: { x: 0, y: 0 },
						data: {
							label: n.label,
							type: n.type,
							framework: n.framework,
						},
						type: "editable" as const,
					};
				});
				const known = new Set(newNodes.map((n) => n.id));
				const newEdges = result.edges
					.filter((e) => known.has(e.source) && known.has(e.target))
					.map((e, i) => ({
						id: `imported-edge-${i}`,
						source: e.source,
						target: e.target,
						data: { label: e.label || "" },
					}));
				// An imported diagram has no coordinates at all; laying it out is the
				// difference between a readable result and a stack at the origin.
				setNodes(autoLayout(newNodes, newEdges));
				setEdges(newEdges);
				const dropped = result.edges.length - newEdges.length;
				toast({
					title: t("codeToVisualDone", "Diagramme généré !"),
					description:
						dropped > 0
							? `${result.summary} — ${t("droppedEdges", "{{count}} connexion(s) ignorée(s)", { count: dropped })}`
							: result.summary,
				});
			}
		},
		[t, setEdges, setNodes],
	);

	// Subscribe to backend events once on mount
	useEffect(() => {
		const offStatus = globalThis.electronAPI?.onVisualProgrammingStatus?.(
			handleVisualProgrammingStatus,
		);
		const offError = globalThis.electronAPI?.onVisualProgrammingError?.(
			handleVisualProgrammingError,
		);
		const offComplete = globalThis.electronAPI?.onVisualProgrammingComplete?.(
			handleVisualProgrammingComplete,
		);
		return () => {
			offStatus?.();
			offError?.();
			offComplete?.();
		};
	}, [
		handleVisualProgrammingComplete,
		handleVisualProgrammingError,
		handleVisualProgrammingStatus,
	]);

	const handleGenerateCode = async () => {
		if (!globalThis.electronAPI?.runVisualProgramming) {
			toast({
				title: t("aiNotAvailable", "IA non disponible"),
				description: "Electron API manquante",
				variant: "destructive",
			});
			return;
		}
		if (nodes.length === 0) {
			toast({
				title: t("emptyDiagram", "Diagramme vide"),
				description: t(
					"addBlocksFirst",
					"Ajoutez des blocs avant de générer du code.",
				),
				variant: "destructive",
			});
			return;
		}
		setIsAiRunning(true);
		setAiStatus(t("starting", "Démarrage…"));
		const diagramJson = JSON.stringify({
			nodes,
			edges: sanitizeEdges(nodes, edges),
			diagramType,
		});
		await globalThis.electronAPI.runVisualProgramming({
			action: "generate-code",
			diagramJson,
			framework: "",
		});
	};

	const handleCodeToVisual = async (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = event.target.files?.[0];
		if (!file) return;
		event.target.value = "";
		if (!globalThis.electronAPI?.runVisualProgramming) {
			toast({
				title: t("aiNotAvailable", "IA non disponible"),
				description: "Electron API manquante",
				variant: "destructive",
			});
			return;
		}
		setIsAiRunning(true);
		setAiStatus(t("starting", "Démarrage…"));
		await globalThis.electronAPI.runVisualProgramming({
			action: "code-to-visual",
			// biome-ignore lint/suspicious/noExplicitAny: Electron's File carries `path`
			filePath: (file as any).path || file.name,
		});
	};

	const onConnect = (params: Edge | Connection) => {
		const src = nodes.find((n) => n.id === params.source);
		const tgt = nodes.find((n) => n.id === params.target);
		const srcType = src?.data?.type as string | undefined;
		const tgtType = tgt?.data?.type as string | undefined;
		// Drawing the same connection twice produced two overlapping edges, two
		// labels stacked on each other, and a duplicated line in the spec.
		if (
			edges.some(
				(e) => e.source === params.source && e.target === params.target,
			)
		) {
			toast({
				title: t("duplicateConnection", "Connexion déjà présente"),
				description: t(
					"duplicateConnectionDesc",
					"Ces deux blocs sont déjà reliés dans ce sens.",
				),
			});
			return;
		}
		// Only allow logical software-architecture edges (e.g. reject Worker →
		// Database). Untyped/custom nodes stay permissive.
		if (!canConnect(srcType, tgtType)) {
			toast({
				title: t("invalidConnection", "Connexion non valide"),
				description: `${t(
					"invalidConnectionDesc",
					"Cet enchaînement n'est pas une suite logique d'architecture.",
				)} (${src?.data?.label ?? params.source} → ${tgt?.data?.label ?? params.target})`,
				variant: "destructive",
			});
			return;
		}
		// Attach a spoken relationship label so the diagram reads as an
		// architecture (and the generated spec is precise).
		const label = connectionLabel(srcType, tgtType, lang);
		setEdges((eds) => addEdge({ ...params, data: { label } }, eds));
	};

	// ── Scaffold on demand ──────────────────────────────────────────────
	// Hand the drawn architecture to WorkPilot's agentic build pipeline: the
	// diagram becomes a task spec, the coder agents scaffold the real project —
	// either in the active project or a fresh greenfield repo.
	const [isScaffolding, setIsScaffolding] = useState(false);
	const [showScaffoldDialog, setShowScaffoldDialog] = useState(false);
	const [scaffoldMode, setScaffoldMode] = useState<"active" | "new">("active");
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectLocation, setNewProjectLocation] = useState("");
	const [initGit, setInitGit] = useState(true);

	const slugify = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "mon-projet";

	// Create the task from the diagram and hand it to the Kanban. The task is
	// tagged `visual-canvas` (distinct card colour) and left in "Planification"
	// (backlog) — the user reviews the generated spec and launches the build
	// from the Kanban when ready (no auto-start).
	const runScaffold = async (projectId: string) => {
		const cleanEdges = sanitizeEdges(nodes, edges);
		const { title, description } = buildArchitectureSpec(
			nodes,
			cleanEdges,
			diagramType,
			lang,
		);
		const task = await createTask(projectId, title, description, {
			sourceType: "visual-canvas",
		});
		if (!task) {
			toast({
				title: t("scaffoldError", "Échec de la création de la tâche"),
				variant: "destructive",
			});
			return;
		}
		globalThis.dispatchEvent(
			new CustomEvent("workpilot:navigate-view", {
				detail: { view: "kanban" },
			}),
		);
		toast({
			title: t("scaffoldQueued", "Tâche créée en Planification"),
			description: t(
				"scaffoldQueuedDesc",
				"Ouvrez le Kanban et lancez-la quand vous voulez.",
			),
		});
	};

	const handleScaffold = async () => {
		if (nodes.length === 0) {
			toast({
				title: t("emptyDiagram", "Diagramme vide"),
				description: t(
					"addBlocksFirst",
					"Ajoutez des blocs avant de scaffolder l'architecture.",
				),
				variant: "destructive",
			});
			return;
		}
		// Prefill the new-project form; default to the active project when one is
		// open, else force greenfield.
		const stacks = [
			...new Set(
				nodes
					.map((n) => (n.data as { framework?: string })?.framework)
					.filter((f): f is string => !!f),
			),
		];
		setNewProjectName(slugify(stacks.join("-") || diagramType));
		if (!newProjectLocation) {
			try {
				const loc = await globalThis.electronAPI?.getDefaultProjectLocation?.();
				if (loc) setNewProjectLocation(loc);
			} catch {
				/* ignore */
			}
		}
		// Snapshot the active project once, imperatively.
		const projState = useProjectStore.getState();
		const proj =
			projState.projects.find((p) => p.id === projState.activeProjectId) ?? null;
		const projInfo = proj ? { id: proj.id, name: proj.name } : null;
		setActiveProject(projInfo);
		setScaffoldMode(projInfo ? "active" : "new");
		setShowScaffoldDialog(true);
	};

	const handleBrowseLocation = async () => {
		const dir = await globalThis.electronAPI?.selectDirectory?.();
		if (dir) setNewProjectLocation(dir);
	};

	const confirmScaffold = async () => {
		setShowScaffoldDialog(false);
		setIsScaffolding(true);
		try {
			let projectId: string | null = null;
			if (scaffoldMode === "active") {
				projectId =
					useProjectStore.getState().activeProjectId ?? activeProject?.id ?? null;
			} else {
				if (!newProjectName.trim() || !newProjectLocation.trim()) {
					toast({
						title: t("newProjectIncomplete", "Projet incomplet"),
						description: t(
							"newProjectIncompleteDesc",
							"Renseignez un nom et un emplacement.",
						),
						variant: "destructive",
					});
					return;
				}
				const created = await globalThis.electronAPI?.createProjectFolder?.(
					newProjectLocation.trim(),
					newProjectName.trim(),
					initGit,
				);
				if (!created?.success || !created.data) {
					toast({
						title: t("newProjectError", "Échec de la création du projet"),
						description: created?.error,
						variant: "destructive",
					});
					return;
				}
				const registered = await registerProject(created.data.path);
				if (!registered) {
					toast({
						title: t("newProjectError", "Échec de la création du projet"),
						variant: "destructive",
					});
					return;
				}
				projectId = registered.project.id;
			}
			if (!projectId) {
				toast({
					title: t("noActiveProject", "Aucun projet actif"),
					variant: "destructive",
				});
				return;
			}
			await runScaffold(projectId);
		} finally {
			setIsScaffolding(false);
		}
	};

	const paneRef = useRef<HTMLDivElement>(null);

	/** Centre of the visible canvas, in diagram coordinates. */
	const viewportCenter = useCallback(() => {
		const instance = reactFlowRef.current;
		const pane = paneRef.current;
		if (instance?.screenToFlowPosition && pane) {
			const box = pane.getBoundingClientRect();
			return instance.screenToFlowPosition({
				x: box.left + box.width / 2,
				y: box.top + box.height / 2,
			});
		}
		return { x: 160 + 40 * nodes.length, y: 120 + 30 * nodes.length };
	}, [nodes.length]);

	const createNode = useCallback(
		(type: string | undefined, position: { x: number; y: number }) => {
			const id = genNodeId();
			const label = type
				? t(blockMeta(type)?.labelKey ?? type, type)
				: t("newBlock", "Nouveau bloc");
			setNodes((nds) => [
				...nds,
				{
					id,
					position,
					data: { label, ...(type ? { type } : {}) },
					type: "editable",
				},
			]);
			return id;
		},
		[setNodes, t],
	);

	/**
	 * Place a block. Types with a meaningful stack choice open the technology
	 * dialog first; the rest (a Redis cache, a CDN) are created straight away —
	 * asking "which framework?" about them had no useful answer.
	 */
	const placeBlock = useCallback(
		(type: string, position: { x: number; y: number }) => {
			if (needsFramework(type)) {
				setPendingNode({ id: genNodeId(), type, position });
				setCustomFramework("");
				setShowFrameworkModal(true);
				return;
			}
			createNode(type, position);
		},
		[createNode],
	);

	const handleAddBlockFromPalette = useCallback(
		(type: string) => placeBlock(type, viewportCenter()),
		[placeBlock, viewportCenter],
	);

	const handleAddNode = () => {
		createNode(undefined, viewportCenter());
	};

	const handleAutoLayout = () => {
		if (nodes.length === 0) return;
		setNodes((nds) => autoLayout(nds, sanitizeEdges(nds, edges)));
		globalThis.setTimeout(
			() => reactFlowRef.current?.fitView?.({ padding: 0.2, duration: 300 }),
			60,
		);
	};

	const handleExportCode = () => {
		const exportData = {
			nodes,
			edges: sanitizeEdges(nodes, edges),
			diagramType,
			exportedAt: new Date().toISOString(),
		};
		saveAs(
			new Blob([JSON.stringify(exportData, null, 2)], {
				type: "application/json",
			}),
			getDefaultFileName(),
		);
	};

	const getDiagramPrefix = (type: string) => {
		if (type === "architecture") return "architectural";
		if (type === "flowchart") return "organigramme";
		if (type === "mockup") return "mockup";
		return "diagram";
	};

	const getDefaultFileName = () => {
		const now = new Date();
		const pad = (n: number, l: number = 2) => n.toString().padStart(l, "0");
		return `${getDiagramPrefix(diagramType)}-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.json`;
	};

	const newDiagram = useCallback(() => {
		const fresh = [
			{
				id: genNodeId(),
				position: { x: 120, y: 80 },
				data: { label: t("newDiagram", "Nouveau diagramme") },
				type: "editable" as const,
				selected: false,
			},
		];
		setNodes(fresh);
		setEdges([]);
		setShowFrameworkModal(false);
		setPendingNode(null);
		// A brand-new diagram has nothing worth saving yet; marking it dirty at
		// birth made the save prompt fire on every second "New diagram".
		setSavedSignature(signature({ nodes: fresh, edges: [] }));
		historyRef.current = initHistory({ nodes: fresh, edges: [] });
		setHistoryTick((v) => v + 1);
	}, [setEdges, setNodes, t]);

	const handleNewDiagram = () => {
		if (isDirty) {
			setPendingAfterSave("new-diagram");
			setSaveAsFileName(getDefaultFileName());
			setShowSaveAsDialog(true);
			return;
		}
		newDiagram();
	};

	const confirmSaveAs = async () => {
		const exportData = {
			nodes,
			edges: sanitizeEdges(nodes, edges),
			diagramType,
			exportedAt: new Date().toISOString(),
		};
		try {
			if (!globalThis.electronAPI?.saveJsonFile) {
				toast({
					title: t("saveError", "Erreur lors de la sauvegarde"),
					description: "Electron API non disponible",
					variant: "destructive",
				});
				return;
			}
			const result = await globalThis.electronAPI.saveJsonFile(
				selectedFolder,
				saveAsFileName,
				exportData,
			);
			if (!result?.success) {
				toast({
					title: t("saveError", "Erreur lors de la sauvegarde"),
					description: result?.error || "Erreur inconnue",
					variant: "destructive",
				});
				return;
			}
			setSavedSignature(currentSignature);
			setShowSaveAsDialog(false);
			toast({
				title: t("saveSuccess", "Sauvegarde réussie"),
				description: `${t("fileSavedIn", "Fichier sauvegardé dans")} ${selectedFolder}`,
			});
			if (pendingAfterSave === "new-diagram") newDiagram();
			setPendingAfterSave(null);
		} catch (e) {
			toast({
				title: t("saveError", "Erreur lors de la sauvegarde"),
				description: e instanceof Error ? e.message : String(e),
				variant: "destructive",
			});
		}
	};

	/** Leave the Save-As dialog without writing, and drop what it was gating. */
	const cancelSaveAs = () => {
		setShowSaveAsDialog(false);
		setPendingAfterSave(null);
	};

	/** "Continue without saving" — only offered when something is waiting. */
	const discardAndContinue = () => {
		setShowSaveAsDialog(false);
		if (pendingAfterSave === "new-diagram") newDiagram();
		setPendingAfterSave(null);
	};

	const handleLoad = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;
		event.target.value = "";
		try {
			const data = JSON.parse(await file.text());
			if (!Array.isArray(data?.nodes)) throw new Error("no nodes");
			const loadedNodes: Node[] = data.nodes.map(
				(n: Node, i: number): Node => ({
					...n,
					id: String(n.id ?? `loaded-${i}`),
					position: n.position ?? { x: 0, y: 0 },
					type: "editable",
					selected: false,
				}),
			);
			const loadedEdges: Edge[] = sanitizeEdges(
				loadedNodes,
				Array.isArray(data.edges) ? data.edges : [],
			);
			setNodes(loadedNodes);
			setEdges(loadedEdges);
			if (DIAGRAM_TYPES.includes(data.diagramType)) {
				setDiagramType(data.diagramType);
			}
			// A file just read from disk *is* the saved state.
			setSavedSignature(signature({ nodes: loadedNodes, edges: loadedEdges }));
			historyRef.current = initHistory({
				nodes: loadedNodes,
				edges: loadedEdges,
			});
			setHistoryTick((v) => v + 1);
			globalThis.setTimeout(
				() => reactFlowRef.current?.fitView?.({ padding: 0.2 }),
				60,
			);
		} catch {
			toast({
				title: t("loadErrorTitle", "Erreur de chargement"),
				description: t("loadErrorDesc", "Le fichier est invalide ou corrompu."),
				variant: "destructive",
			});
		}
	};

	const handleDrop = (event: React.DragEvent) => {
		event.preventDefault();
		const type = event.dataTransfer.getData("application/block-type");
		if (!type) return;
		const instance = reactFlowRef.current;
		// screenToFlowPosition maps the cursor's screen coords into the canvas'
		// coordinate space, accounting for the current pan/zoom, so the block
		// lands exactly under the drop point. Fall back to pane-relative coords
		// if the instance isn't ready yet.
		let position: { x: number; y: number };
		if (instance?.screenToFlowPosition) {
			position = instance.screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});
		} else {
			const bounds = event.currentTarget.getBoundingClientRect();
			position = {
				x: event.clientX - bounds.left,
				y: event.clientY - bounds.top,
			};
		}
		placeBlock(type, position);
	};

	const handleDragOver = (event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const handleFrameworkSelect = (framework: string) => {
		if (!pendingNode) return;
		const meta = blockMeta(pendingNode.type);
		const typeLabel = t(meta?.labelKey ?? pendingNode.type, pendingNode.type);
		setNodes((nds) => [
			...nds,
			{
				id: pendingNode.id,
				position: pendingNode.position,
				data: {
					label: `${typeLabel} ${framework}`.trim(),
					type: pendingNode.type,
					framework,
				},
				type: "editable",
			},
		]);
		setShowFrameworkModal(false);
		setPendingNode(null);
		setCustomFramework("");
	};

	/** Create the block with no stack chosen — the inspector can set one later. */
	const skipFramework = () => {
		if (!pendingNode) return;
		createNode(pendingNode.type, pendingNode.position);
		setShowFrameworkModal(false);
		setPendingNode(null);
		setCustomFramework("");
	};

	const deleteSelectedElements = useCallback(() => {
		const doomed = new Set(
			nodes.filter((n) => n.selected).map((n) => n.id),
		);
		setNodes((nds) => nds.filter((n) => !n.selected));
		setEdges((eds) =>
			eds.filter(
				(e) => !e.selected && !doomed.has(e.source) && !doomed.has(e.target),
			),
		);
	}, [nodes, setEdges, setNodes]);

	// ── Keyboard ────────────────────────────────────────────────────────
	// This listener is on the window, so without the guard below every
	// Backspace typed into the filename field, the project name, or a node
	// being renamed silently deleted the current selection.
	useEffect(() => {
		const isTextEntry = (target: EventTarget | null) => {
			const el = target as HTMLElement | null;
			if (!el) return false;
			const tag = el.tagName;
			return (
				tag === "INPUT" ||
				tag === "TEXTAREA" ||
				tag === "SELECT" ||
				el.isContentEditable
			);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (isTextEntry(e.target)) return;
			const mod = e.ctrlKey || e.metaKey;
			if (mod && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (e.shiftKey) handleRedo();
				else handleUndo();
				return;
			}
			if (mod && e.key.toLowerCase() === "y") {
				e.preventDefault();
				handleRedo();
				return;
			}
			if (e.key === "Delete" || e.key === "Backspace") {
				e.preventDefault();
				deleteSelectedElements();
			}
		};
		globalThis.addEventListener("keydown", onKeyDown);
		return () => globalThis.removeEventListener("keydown", onKeyDown);
	}, [deleteSelectedElements, handleRedo, handleUndo]);

	const handleSaveAs = () => {
		setPendingAfterSave(null);
		setSaveAsFileName(getDefaultFileName());
		setShowSaveAsDialog(true);
	};

	// Sync canvas state to store so it survives page/tab navigation. No
	// callback-stripping needed any more — state never held any.
	useEffect(() => {
		setCanvasNodes(nodes);
	}, [nodes, setCanvasNodes]);

	useEffect(() => {
		setCanvasEdges(edges);
	}, [edges, setCanvasEdges]);

	useEffect(() => {
		setCanvasDiagramType(diagramType);
	}, [diagramType, setCanvasDiagramType]);

	const getFallbackExplorerRoot = useCallback(() => {
		// biome-ignore lint/suspicious/noExplicitAny: injected by the preload bridge
		if ((globalThis as any).platform?.isWindows) return "C:\\";
		return "/";
	}, []);
	const [explorerRoot, setExplorerRoot] = useState(getFallbackExplorerRoot());
	const [explorerRootInput, setExplorerRootInput] = useState(explorerRoot);

	useEffect(() => {
		let cancelled = false;
		const api = globalThis.electronAPI?.getUserHome;
		if (!api) return;
		(async () => {
			try {
				const home = await api();
				if (cancelled || !home) return;
				setExplorerRoot((prev) =>
					prev === getFallbackExplorerRoot() ? home : prev,
				);
				setExplorerRootInput((prev) =>
					prev === getFallbackExplorerRoot() ? home : prev,
				);
			} catch {
				// keep fallback
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [getFallbackExplorerRoot]);

	const frameworkOptions = pendingNode
		? (FRAMEWORKS_BY_TYPE[pendingNode.type] ?? [])
		: [];
	const inspectedType = inspected?.data?.type as string | undefined;
	const inspectorStacks = inspectedType
		? (FRAMEWORKS_BY_TYPE[inspectedType] ?? [])
		: [];

	return (
		<div className="flex flex-col h-full flex-1 relative">
			{/* Toolbar */}
			<div className="flex items-center gap-1 px-2 py-1.5 border-b bg-background shrink-0">
				{/* Group 1 — Document */}
				<Button
					size="sm"
					variant="ghost"
					onClick={handleNewDiagram}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("newDiagram", "Nouveau diagramme")}
				>
					<FilePlus2 className="h-3.5 w-3.5" />
					<span className="hidden md:inline">
						{t("newDiagram", "Nouveau diagramme")}
					</span>
				</Button>
				<select
					value={diagramType}
					onChange={(e) => setDiagramType(e.target.value as DiagramType)}
					aria-label={t("diagramType", "Type de diagramme")}
					title={t("diagramType", "Type de diagramme")}
					className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground outline-none focus:border-primary"
				>
					{DIAGRAM_TYPES.map((type) => (
						<option key={type} value={type}>
							{t(`diagramType_${type}`, type)}
						</option>
					))}
				</select>

				<div className="h-5 w-px bg-border mx-0.5" />

				{/* Group 2 — Canvas editing */}
				<Button
					size="sm"
					variant={showPalette ? "secondary" : "ghost"}
					onClick={() => setShowPalette((v) => !v)}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("togglePalette", "Afficher/masquer la palette de blocs")}
				>
					{showPalette ? (
						<PanelLeftClose className="h-3.5 w-3.5" />
					) : (
						<Blocks className="h-3.5 w-3.5" />
					)}
					<span className="hidden md:inline">{t("palette", "Palette")}</span>
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={handleAddNode}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("addBlock", "Ajouter un bloc")}
				>
					<Plus className="h-3.5 w-3.5" />
					<span className="hidden md:inline">{t("addBlock", "Bloc")}</span>
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={handleUndo}
					disabled={!undoAvailable}
					className="h-7 w-7 p-0"
					title={t("undo", "Annuler (Ctrl+Z)")}
					aria-label={t("undo", "Annuler (Ctrl+Z)")}
				>
					<Undo2 className="h-3.5 w-3.5" />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={handleRedo}
					disabled={!redoAvailable}
					className="h-7 w-7 p-0"
					title={t("redo", "Rétablir (Ctrl+Maj+Z)")}
					aria-label={t("redo", "Rétablir (Ctrl+Maj+Z)")}
				>
					<Redo2 className="h-3.5 w-3.5" />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={handleAutoLayout}
					disabled={nodes.length === 0}
					className="h-7 w-7 p-0"
					title={t("autoLayout", "Organiser automatiquement")}
					aria-label={t("autoLayout", "Organiser automatiquement")}
				>
					<LayoutGrid className="h-3.5 w-3.5" />
				</Button>
				<input
					type="file"
					ref={codeToVisualInputRef}
					style={{ display: "none" }}
					accept=".js,.ts,.tsx,.jsx,.py,.cs,.java,.go,.rb,.vue,.svelte"
					onChange={handleCodeToVisual}
				/>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => codeToVisualInputRef.current?.click()}
					disabled={isAiRunning}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t(
						"reverseTooltip",
						"Analyser un fichier source et générer le diagramme correspondant",
					)}
				>
					<ArrowLeftRight className="h-3.5 w-3.5" />
					<span className="hidden md:inline">
						{t("reverse", "Code → Visuel")}
					</span>
				</Button>

				<div className="h-5 w-px bg-border mx-0.5" />

				{/* Group 3 — AI: primary action (full agentic scaffold) */}
				<Button
					size="sm"
					onClick={handleScaffold}
					disabled={isScaffolding || nodes.length === 0}
					title={t(
						"scaffoldTooltip",
						"Scaffolder le projet complet (production-ready) via le pipeline agentique, dans le projet actif",
					)}
					className="gap-1.5 h-7 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
				>
					{isScaffolding ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Rocket className="h-3.5 w-3.5" />
					)}
					{isScaffolding
						? t("scaffolding", "Création…")
						: t("scaffold", "Scaffolder")}
				</Button>

				{/* Secondary — one-shot code preview */}
				<Button
					size="sm"
					variant="outline"
					onClick={handleGenerateCode}
					disabled={isAiRunning || nodes.length === 0}
					title={t(
						"generateCodeTooltip",
						"Aperçu rapide : génère une ébauche de code en un appel (non écrite dans le projet)",
					)}
					className="gap-1.5 h-7 px-3 text-xs"
				>
					{isAiRunning ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Sparkles className="h-3.5 w-3.5" />
					)}
					{isAiRunning
						? aiStatus || t("generating", "Génération…")
						: t("codePreview", "Aperçu du code")}
				</Button>

				{/* Spacer */}
				<div className="flex-1" />

				{/* Group 4 — File operations */}
				<Button
					size="sm"
					variant="ghost"
					onClick={handleExportCode}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("export", "Exporter JSON")}
				>
					<FileJson className="h-3.5 w-3.5" />
					<span className="hidden lg:inline">{t("export", "Exporter")}</span>
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={handleSaveAs}
					className="gap-1.5 h-7 px-2 text-xs relative"
					title={t("saveAs", "Enregistrer sous…")}
				>
					<Save className="h-3.5 w-3.5" />
					<span className="hidden lg:inline">{t("saveAs", "Enregistrer")}</span>
					{isDirty && (
						<span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
					)}
				</Button>
				<input
					type="file"
					ref={loadInputRef}
					style={{ display: "none" }}
					accept=".json"
					onChange={handleLoad}
				/>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => loadInputRef.current?.click()}
					className="gap-1.5 h-7 px-2 text-xs"
					title={t("load", "Charger")}
				>
					<FolderOpen className="h-3.5 w-3.5" />
					<span className="hidden lg:inline">{t("load", "Charger")}</span>
				</Button>
			</div>

			<div className="flex flex-1 min-h-0">
				{showPalette ? (
					<div className="relative flex w-60 shrink-0 flex-col border-r bg-background p-2">
						<VisualProgrammingPalette
							onAddBlock={handleAddBlockFromPalette}
						/>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setShowPalette(true)}
						title={t("togglePalette", "Afficher/masquer la palette de blocs")}
						className="flex w-8 shrink-0 items-start justify-center border-r bg-background pt-3 text-muted-foreground hover:text-foreground"
					>
						<PanelLeftOpen className="h-4 w-4" />
					</button>
				)}

				<div
					ref={paneRef}
					className="relative flex-1 min-h-0 overflow-hidden bg-muted/30"
				>
					<ReactFlow
						onInit={(instance) => {
							reactFlowRef.current = instance;
						}}
						key={diagramType}
						nodes={renderNodes}
						edges={renderEdges}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						onConnect={onConnect}
						fitView={true}
						edgeTypes={edgeTypes}
						nodeTypes={nodeTypes}
						multiSelectionKeyCode={["Shift", "Meta", "Control"]}
						deleteKeyCode={null}
						proOptions={{ hideAttribution: true }}
						onDrop={handleDrop}
						onDragOver={handleDragOver}
					>
						<Controls showInteractive={false} />
						{/* Collapsed to a small thumbnail; expands on hover. Pannable/
						    zoomable so clicking-dragging it navigates the diagram. */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: expands a preview on hover, carries no action of its own */}
						{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: expands a preview on hover, carries no action of its own */}
						<div
							onMouseEnter={() => setMiniMapExpanded(true)}
							onMouseLeave={() => setMiniMapExpanded(false)}
							onFocus={() => setMiniMapExpanded(true)}
							onBlur={() => setMiniMapExpanded(false)}
							style={{
								position: "absolute",
								right: 12,
								bottom: 12,
								zIndex: 11,
							}}
						>
							<MiniMap
								pannable
								zoomable
								// Typed nodes carry their palette accent into the minimap, so
								// the thumbnail is a map rather than a grey smear. The panel
								// itself follows the theme instead of the hard-coded white it
								// used to paint over every dark canvas.
								nodeColor={(n) => blockAccent(n.data?.type as string)}
								maskColor="color-mix(in srgb, var(--background) 65%, transparent)"
								style={{
									position: "relative",
									margin: 0,
									width: miniMapExpanded ? 200 : 52,
									height: miniMapExpanded ? 140 : 40,
									opacity: miniMapExpanded ? 1 : 0.6,
									transition: "width 0.2s, height 0.2s, opacity 0.2s",
									background: "var(--card, #17171b)",
									border: "1px solid var(--border, #33333a)",
									borderRadius: 8,
								}}
							/>
						</div>
						<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
					</ReactFlow>

					{/* Empty state — the canvas used to be an unexplained grid. */}
					{nodes.length === 0 && (
						<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
							<div className="max-w-xs rounded-lg border border-dashed bg-background/80 px-6 py-5 text-center backdrop-blur-sm">
								<MousePointerSquareDashed className="mx-auto mb-2 h-7 w-7 text-muted-foreground" />
								<p className="text-sm font-medium text-foreground">
									{t("emptyCanvasTitle", "Le canvas est vide")}
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{t(
										"emptyCanvasHint",
										"Glissez un bloc depuis la palette, ou cliquez-le, pour commencer votre architecture.",
									)}
								</p>
							</div>
						</div>
					)}
				</div>

				{/* Inspector — the only place a block's stack can be changed after
				    it is created. Before this, a wrong choice in the technology
				    dialog meant deleting the block and drawing it again. */}
				{inspected && (
					<aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3">
						<div className="flex items-center justify-between">
							<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{t("inspector", "Bloc sélectionné")}
							</span>
							<button
								type="button"
								onClick={() => handleDeleteNode(inspected.id)}
								title={t("deleteBlock", "Supprimer le bloc")}
								aria-label={t("deleteBlock", "Supprimer le bloc")}
								className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
							>
								<Trash2 className="h-3.5 w-3.5" />
							</button>
						</div>

						<div>
							<label
								htmlFor="inspector-name"
								className="mb-1 block text-[11px] font-medium text-muted-foreground"
							>
								{t("blockName", "Nom")}
							</label>
							<input
								id="inspector-name"
								type="text"
								value={String(inspected.data?.label ?? "")}
								onChange={(e) =>
									handleRenameNode(inspected.id, e.target.value)
								}
								className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
							/>
						</div>

						<div>
							<span className="mb-1 block text-[11px] font-medium text-muted-foreground">
								{t("blockRole", "Rôle")}
							</span>
							<p className="flex items-center gap-1.5 text-xs text-foreground">
								<span
									className="inline-block h-2 w-2 rounded-full"
									style={{ backgroundColor: blockAccent(inspectedType) }}
								/>
								{inspectedType
									? t(blockMeta(inspectedType)?.labelKey ?? inspectedType)
									: t("untyped", "Bloc libre")}
							</p>
						</div>

						{inspectorStacks.length > 0 && (
							<div>
								<label
									htmlFor="inspector-stack"
									className="mb-1 block text-[11px] font-medium text-muted-foreground"
								>
									{t("blockStack", "Technologie")}
								</label>
								<select
									id="inspector-stack"
									value={String(inspected.data?.framework ?? "")}
									onChange={(e) =>
										handleSetFramework(inspected.id, e.target.value)
									}
									className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
								>
									<option value="">{t("noStack", "Non précisée")}</option>
									{inspectorStacks.map((fw) => (
										<option key={fw} value={fw}>
											{t(fw, fw)}
										</option>
									))}
								</select>
							</div>
						)}

						<p className="mt-auto text-[10px] leading-snug text-muted-foreground">
							{t(
								"inspectorHint",
								"Double-cliquez un bloc pour le renommer sur le canvas, ou une connexion pour changer son libellé.",
							)}
						</p>
					</aside>
				)}
			</div>

			{/* Status bar */}
			<div className="flex shrink-0 items-center gap-3 border-t bg-background px-3 py-1 text-[11px] text-muted-foreground">
				<span className="tabular-nums">
					{t("statusBlocks", "{{count}} blocs", { count: nodes.length })}
				</span>
				<span className="tabular-nums">
					{t("statusConnections", "{{count}} connexions", {
						count: edges.length,
					})}
				</span>
				<span className="flex-1" />
				{isDirty ? (
					<span className="flex items-center gap-1 text-amber-500">
						<span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
						{t("statusUnsaved", "Non enregistré")}
					</span>
				) : (
					<span>{t("statusSaved", "Enregistré")}</span>
				)}
			</div>

			{/* Technology chooser */}
			<Dialog open={showFrameworkModal} onOpenChange={setShowFrameworkModal}>
				<DialogContent>
					<DialogTitle>{t("chooseFramework")}</DialogTitle>
					<DialogDescription>
						{t(
							"chooseFrameworkDesc",
							"Sélectionnez le framework ou la technologie pour ce bloc.",
						)}
					</DialogDescription>
					<div className="mt-3 grid grid-cols-3 gap-1.5">
						{frameworkOptions.map((fw) => (
							<Button
								key={fw}
								variant="outline"
								size="sm"
								className="h-8 text-xs"
								onClick={() => handleFrameworkSelect(fw)}
							>
								{t(fw, fw)}
							</Button>
						))}
					</div>
					<div className="mt-3">
						<label
							htmlFor="custom-framework"
							className="mb-1 block text-xs font-medium text-muted-foreground"
						>
							{t("otherStack", "Autre technologie")}
						</label>
						<div className="flex gap-2">
							<input
								id="custom-framework"
								type="text"
								value={customFramework}
								onChange={(e) => setCustomFramework(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && customFramework.trim()) {
										handleFrameworkSelect(customFramework.trim());
									}
								}}
								placeholder={t("otherStackPlaceholder", "ex. Quarkus")}
								className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
							/>
							<Button
								size="sm"
								variant="secondary"
								disabled={!customFramework.trim()}
								onClick={() => handleFrameworkSelect(customFramework.trim())}
							>
								{t("use", "Utiliser")}
							</Button>
						</div>
					</div>
					<DialogFooter className="mt-4">
						<Button variant="ghost" onClick={skipFramework}>
							{t("skipStack", "Sans technologie")}
						</Button>
						<Button
							variant="ghost"
							onClick={() => {
								setShowFrameworkModal(false);
								setPendingNode(null);
							}}
						>
							{t("cancel", "Annuler")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={showSaveAsDialog}
				onOpenChange={(open) => {
					if (!open) cancelSaveAs();
				}}
			>
				<DialogContent>
					<DialogTitle>
						{t("chooseFileName", "Nom du fichier d'export")}
					</DialogTitle>
					<div className="mt-4">
						<DialogDescription>
							{pendingAfterSave
								? t(
										"saveBeforeNew",
										"Ce diagramme a des modifications non enregistrées. Enregistrez-le avant d'en créer un nouveau.",
									)
								: t(
										"chooseFileNameDesc",
										"Vous pouvez modifier le nom du fichier avant l'enregistrement.",
									)}
						</DialogDescription>
					</div>
					<div className="mt-4">
						<label
							htmlFor="explorer-root-input"
							className="block text-xs font-bold mb-1"
						>
							{t("explorerRoot", "Racine de l'explorateur :")}
						</label>
						<div className="flex gap-2">
							<input
								id="explorer-root-input"
								type="text"
								value={explorerRootInput}
								onChange={(e) => setExplorerRootInput(e.target.value)}
								className="w-full p-2 border rounded"
								placeholder="C:\\ ou /"
							/>
							<Button
								variant="secondary"
								onClick={() => setExplorerRoot(explorerRootInput)}
								disabled={explorerRootInput.length === 0}
							>
								{t("selectFolder", "Sélectionner")}
							</Button>
						</div>
					</div>
					<div
						className="mt-4"
						style={{ maxHeight: "60vh", overflowY: "auto" }}
					>
						<FileTree
							rootPath={explorerRoot}
							onSelectFolder={setSelectedFolder}
							selectedFolder={selectedFolder}
						/>
						<div className="mt-2 text-sm font-bold text-primary">
							{t("selectedFolder", "Selected folder")}:{" "}
							{selectedFolder || t("noFolder", "None")}
						</div>
					</div>
					<div className="mt-4">
						<label
							htmlFor="save-as-filename"
							className="block text-xs font-bold mb-1"
						>
							{t("fileNameLabel", "Nom du fichier :")}
						</label>
						<input
							id="save-as-filename"
							type="text"
							value={saveAsFileName}
							onChange={(e) => setSaveAsFileName(e.target.value)}
							className="w-full mt-1 p-2 border rounded"
						/>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={confirmSaveAs}
							disabled={
								!selectedFolder ||
								!saveAsFileName ||
								saveAsFileName.trim().length === 0
							}
						>
							{t("save", "Sauvegarder dans le dossier sélectionné")}
						</Button>
						{pendingAfterSave && (
							<Button variant="ghost" onClick={discardAndContinue}>
								{t("continueWithoutSaving", "Continuer sans enregistrer")}
							</Button>
						)}
						<Button variant="ghost" onClick={cancelSaveAs}>
							{t("cancel", "Annuler")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Scaffold target dialog — active project vs. new greenfield repo */}
			<Dialog open={showScaffoldDialog} onOpenChange={setShowScaffoldDialog}>
				<DialogContent>
					<DialogTitle>
						{t("scaffoldTargetTitle", "Où générer le projet ?")}
					</DialogTitle>
					<DialogDescription>
						{t(
							"scaffoldTargetDesc",
							"L'architecture est transformée en tâche puis construite par le pipeline agentique.",
						)}
					</DialogDescription>
					<div className="mt-4 flex flex-col gap-2">
						<button
							type="button"
							onClick={() => activeProject && setScaffoldMode("active")}
							disabled={!activeProject}
							className={`text-left rounded-md border p-3 text-sm transition-colors disabled:opacity-50 ${
								scaffoldMode === "active"
									? "border-emerald-500 bg-emerald-500/10"
									: "hover:bg-accent/50"
							}`}
						>
							<div className="font-medium">
								{t("scaffoldInActive", "Projet actif")}
							</div>
							<div className="text-xs text-muted-foreground">
								{activeProject
									? activeProject.name
									: t("noActiveProject", "Aucun projet actif")}
							</div>
						</button>
						<button
							type="button"
							onClick={() => setScaffoldMode("new")}
							className={`text-left rounded-md border p-3 text-sm transition-colors ${
								scaffoldMode === "new"
									? "border-emerald-500 bg-emerald-500/10"
									: "hover:bg-accent/50"
							}`}
						>
							<div className="font-medium">
								{t("scaffoldInNew", "Nouveau projet (repo greenfield)")}
							</div>
							<div className="text-xs text-muted-foreground">
								{t(
									"scaffoldInNewDesc",
									"Crée un dossier + dépôt Git, puis génère dedans.",
								)}
							</div>
						</button>
					</div>

					{scaffoldMode === "new" && (
						<div className="mt-3 flex flex-col gap-3">
							<div>
								<label
									htmlFor="scaffold-proj-name"
									className="block text-xs font-bold mb-1"
								>
									{t("projectName", "Nom du projet")}
								</label>
								<input
									id="scaffold-proj-name"
									type="text"
									value={newProjectName}
									onChange={(e) => setNewProjectName(e.target.value)}
									className="w-full p-2 border rounded text-sm"
									placeholder="mon-projet"
								/>
							</div>
							<div>
								<label
									htmlFor="scaffold-proj-loc"
									className="block text-xs font-bold mb-1"
								>
									{t("projectLocation", "Emplacement")}
								</label>
								<div className="flex gap-2">
									<input
										id="scaffold-proj-loc"
										type="text"
										value={newProjectLocation}
										onChange={(e) => setNewProjectLocation(e.target.value)}
										className="w-full p-2 border rounded text-sm"
										placeholder="C:\\ ou /"
									/>
									<Button variant="secondary" onClick={handleBrowseLocation}>
										{t("browse", "Parcourir")}
									</Button>
								</div>
							</div>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={initGit}
									onChange={(e) => setInitGit(e.target.checked)}
								/>
								{t("initGit", "Initialiser un dépôt Git")}
							</label>
						</div>
					)}

					<DialogFooter className="mt-4">
						<Button
							variant="outline"
							onClick={confirmScaffold}
							disabled={
								scaffoldMode === "active"
									? !activeProject
									: !newProjectName.trim() || !newProjectLocation.trim()
							}
						>
							{t("scaffold", "Générer le projet")}
						</Button>
						<Button
							variant="ghost"
							onClick={() => setShowScaffoldDialog(false)}
						>
							{t("cancel", "Annuler")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Generated Code Dialog */}
			<Dialog open={showCodeResult} onOpenChange={setShowCodeResult}>
				<DialogContent
					style={{ maxWidth: "80vw", maxHeight: "90vh", overflowY: "auto" }}
				>
					<DialogTitle>
						{t("generatedCodeTitle", "Code généré par IA")}
					</DialogTitle>
					{codeResult && (
						<>
							<DialogDescription>{codeResult.summary}</DialogDescription>
							{codeResult.files.length > 1 && (
								<div className="flex gap-1 flex-wrap mt-2">
									{codeResult.files.map((f, i) => (
										<Button
											key={f.filename}
											variant={i === selectedCodeFile ? "default" : "outline"}
											size="sm"
											onClick={() => setSelectedCodeFile(i)}
										>
											{f.filename}
										</Button>
									))}
								</div>
							)}
							{codeResult.files[selectedCodeFile] && (
								<div className="mt-3">
									<p className="text-xs font-mono text-muted-foreground mb-1">
										{codeResult.files[selectedCodeFile].filename}
									</p>
									<pre
										className="text-xs bg-muted rounded p-3 overflow-auto"
										style={{
											maxHeight: "50vh",
											whiteSpace: "pre-wrap",
											wordBreak: "break-all",
										}}
									>
										{codeResult.files[selectedCodeFile].content}
									</pre>
								</div>
							)}
							{codeResult.instructions && (
								<p className="mt-2 text-sm text-muted-foreground">
									{codeResult.instructions}
								</p>
							)}
							<DialogFooter className="mt-4">
								<Button
									variant="outline"
									onClick={() => {
										const file = codeResult.files[selectedCodeFile];
										if (!file) return;
										saveAs(
											new Blob([file.content], { type: "text/plain" }),
											file.filename.split("/").pop() || "generated.txt",
										);
									}}
								>
									{t("downloadFile", "Télécharger ce fichier")}
								</Button>
								<Button
									variant="outline"
									onClick={() => {
										codeResult.files.forEach((f) => {
											saveAs(
												new Blob([f.content], { type: "text/plain" }),
												f.filename.split("/").pop() || "generated.txt",
											);
										});
									}}
								>
									{t("downloadAll", "Tout télécharger")}
								</Button>
								<Button
									variant="ghost"
									onClick={() => setShowCodeResult(false)}
								>
									{t("close", "Fermer")}
								</Button>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
};
