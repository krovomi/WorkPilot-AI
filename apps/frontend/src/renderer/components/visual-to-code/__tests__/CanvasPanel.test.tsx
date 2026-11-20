/**
 * @vitest-environment jsdom
 */
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import type { Edge, EdgeChange, Node, NodeChange } from "reactflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
			const vars = (typeof fallback === "object" ? fallback : opts) ?? {};
			const raw = typeof fallback === "string" && fallback ? fallback : key;
			return raw.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(vars[n] ?? ""));
		},
		i18n: { language: "fr" },
	}),
}));

/**
 * ReactFlow needs a measured pane; here it is a list of the blocks it was
 * given, and the props it received are kept so a test can play the gestures
 * the canvas would report (selecting, dragging, connecting).
 */
interface FlowProps {
	nodes: Node[];
	edges: Edge[];
	onNodesChange: (changes: NodeChange[]) => void;
	onEdgesChange: (changes: EdgeChange[]) => void;
}

interface MiniMapProps {
	nodeColor: (node: Partial<Node>) => string;
	style: { width: number; height: number };
}

const flow = vi.hoisted(() => ({
	props: null as unknown as FlowProps,
	minimap: null as unknown as MiniMapProps,
	instance: null as null | {
		fitView: ReturnType<typeof vi.fn>;
		screenToFlowPosition?: (p: { x: number; y: number }) => { x: number; y: number };
	},
}));

vi.mock("reactflow", async (importOriginal) => {
	const actual = await importOriginal<typeof import("reactflow")>();
	const React = await import("react");
	function FakeFlow(props: {
		nodes: Node[];
		children: React.ReactNode;
		onInit?: (instance: unknown) => void;
		onDrop?: React.DragEventHandler;
		onDragOver?: React.DragEventHandler;
	}) {
		flow.props = props as unknown as FlowProps;
		const { onInit } = props;
		React.useEffect(() => {
			if (flow.instance) onInit?.(flow.instance);
		}, [onInit]);
		return React.createElement(
			"div",
			{ "data-testid": "reactflow-canvas", onDrop: props.onDrop, onDragOver: props.onDragOver },
			props.nodes.map((n) => React.createElement("span", { key: n.id, "data-testid": "block" }, String(n.data?.label))),
			props.children,
		);
	}
	return {
		...actual,
		default: FakeFlow,
		MiniMap: (props: unknown) => {
			flow.minimap = props as MiniMapProps;
			return null;
		},
		Controls: () => null,
		Background: () => null,
	};
});

vi.mock("file-saver", () => ({ saveAs: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("../../ui/code-editor", () => ({ CodeEditor: () => null }));
vi.mock("../../FileTree", () => ({
	FileTree: ({ onSelectFolder }: { onSelectFolder: (p: string) => void }) => (
		<button type="button" onClick={() => onSelectFolder("/work/exports")}>
			exports
		</button>
	),
}));
vi.mock("../../../stores/task-store", () => ({ createTask: vi.fn() }));
vi.mock("../../../stores/project-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../stores/project-store")>();
	return { ...actual, addProject: vi.fn() };
});

import { saveAs } from "file-saver";
import { toast } from "@/hooks/use-toast";
import { BRICK_DRAG_PREFIX } from "../../../lib/custom-bricks";
import { useCustomBricksStore } from "../../../stores/custom-bricks-store";
import { addProject, useProjectStore } from "../../../stores/project-store";
import { createTask } from "../../../stores/task-store";
import { type Architecture, useVisualToCodeStore } from "../../../stores/visual-to-code-store";
import { CanvasPanel } from "../CanvasPanel";

const API = {
	appendArchitectureVersion: vi.fn(),
	listArchitectureVersions: vi.fn(),
	getArchitectureVersion: vi.fn(),
	labelArchitectureVersion: vi.fn(),
	deleteArchitectureVersion: vi.fn(),
	deleteArchitectureHistory: vi.fn(),
	runVisualProgramming: vi.fn(),
	saveJsonFile: vi.fn(),
	selectDirectory: vi.fn(),
	getDefaultProjectLocation: vi.fn(),
	createProjectFolder: vi.fn(),
};

function block(id: string, label: string, type?: string, extra: Partial<Node> = {}): Node {
	return { id, position: { x: 0, y: 0 }, type: "editable", data: { label, ...(type ? { type } : {}) }, ...extra };
}

function architecture(id: string, name: string, nodes: Node[] = [], edges: Edge[] = []): Architecture {
	return {
		id,
		name,
		diagramType: "architecture",
		nodes,
		edges,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const initialStore = useVisualToCodeStore.getState();

function openOn(...architectures: Architecture[]) {
	useVisualToCodeStore.setState({
		...initialStore,
		activeMode: "canvas",
		architectures,
		activeArchitectureId: architectures[0]?.id ?? null,
	});
}

const doc = (id: string) => useVisualToCodeStore.getState().architectures.find((a) => a.id === id);
const blocks = () => screen.queryAllByTestId("block").map((b) => b.textContent);
const lastToast = () => vi.mocked(toast).mock.calls.at(-1)?.[0] as { title?: string; description?: string };

/** A gesture the canvas reports, applied the way ReactFlow would. */
function canvasNodes(changes: NodeChange[]) {
	act(() => flow.props.onNodesChange(changes));
}

/** A drop at a point of the screen (jsdom's events carry no coordinates). */
function dropAt(target: HTMLElement, type: string, x = 0, y = 0) {
	const event = createEvent.drop(target, { dataTransfer: { getData: () => type } });
	Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
	fireEvent(target, event);
}

function pickFile(input: HTMLElement, file: File | null) {
	fireEvent.change(input, { target: { files: file ? [file] : [] } });
}

beforeEach(() => {
	vi.resetAllMocks();
	flow.instance = { fitView: vi.fn(), screenToFlowPosition: (p) => ({ x: p.x + 1, y: p.y + 1 }) };
	Object.assign(globalThis.electronAPI, API);
	API.appendArchitectureVersion.mockResolvedValue({ success: true, data: [] });
	API.runVisualProgramming.mockResolvedValue({ success: true });
	useCustomBricksStore.setState({ bricks: [] });
	useProjectStore.setState({ projects: [], activeProjectId: null });
	openOn(architecture("a1", "Shop", [block("n1", "Orders API", "backend"), block("n2", "Orders DB", "database")]));
});

afterEach(() => vi.useRealTimers());

describe("CanvasPanel — the document on the canvas", () => {
	it("opens the active architecture and writes edits back into it", async () => {
		render(<CanvasPanel />);
		expect(blocks()).toEqual(["Orders API", "Orders DB"]);
		fireEvent.click(screen.getByRole("button", { name: "Bloc" }));
		expect(blocks()).toHaveLength(3);
		await waitFor(() => expect(doc("a1")?.nodes).toHaveLength(3));
		expect(screen.getByText("Non enregistré")).toBeInTheDocument();
	});

	it("writes the edits of the document being left before showing the next one", () => {
		openOn(architecture("a1", "Shop", [block("n1", "Orders API", "backend")]), architecture("a2", "Blog", [block("b1", "Posts")]));
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Bloc" }));
		// Well inside the mirror's coalescing window.
		fireEvent.click(screen.getByRole("tab", { name: "Blog" }));
		expect(blocks()).toEqual(["Posts"]);
		expect(doc("a1")?.nodes).toHaveLength(2);
	});

	it("waits for a document, and ignores an active id that names none", () => {
		useVisualToCodeStore.setState({ activeArchitectureId: null });
		const { unmount } = render(<CanvasPanel />);
		expect(blocks()).toEqual([]);
		expect(screen.getByText("Le canvas est vide")).toBeInTheDocument();
		unmount();
		useVisualToCodeStore.setState({ activeArchitectureId: "gone" });
		render(<CanvasPanel />);
		expect(blocks()).toEqual([]);
	});

	it("duplicates the architecture and starts a new one beside it", () => {
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Dupliquer l'architecture" }));
		expect(useVisualToCodeStore.getState().architectures).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Nouvelle architecture" }));
		expect(useVisualToCodeStore.getState().architectures).toHaveLength(3);
		expect(blocks()).toEqual([]);
	});

	it("does nothing on duplicate before a document is open", () => {
		useVisualToCodeStore.setState({ architectures: [], activeArchitectureId: null });
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Dupliquer l'architecture" }));
		expect(useVisualToCodeStore.getState().architectures).toEqual([]);
	});

	it("changes the diagram type, and the file name follows it", () => {
		render(<CanvasPanel />);
		const type = screen.getByLabelText("Type de diagramme");
		fireEvent.change(type, { target: { value: "flowchart" } });
		fireEvent.click(screen.getByRole("button", { name: "Exporter" }));
		const [blob, name] = vi.mocked(saveAs).mock.calls[0] as [Blob, string];
		expect(name).toMatch(/^organigramme-export-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.json$/);
		expect(blob.type).toBe("application/json");
		fireEvent.change(type, { target: { value: "mockup" } });
		fireEvent.click(screen.getByRole("button", { name: "Exporter" }));
		expect(vi.mocked(saveAs).mock.calls[1][1]).toMatch(/^mockup-export-/);
	});
});

describe("CanvasPanel — placing blocks", () => {
	function paletteBlock(name: string) {
		return screen
			.getAllByText(name)
			.map((e) => e.closest("[draggable]"))
			.find(Boolean) as HTMLElement;
	}

	it("asks for the stack of a block that has one, then places it named after it", async () => {
		render(<CanvasPanel />);
		fireEvent.click(paletteBlock("worker"));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Celery" }));
		expect(blocks()).toContain("worker Celery");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("takes a stack of one's own by Enter or by the button, places without one, or cancels", async () => {
		render(<CanvasPanel />);
		fireEvent.click(paletteBlock("worker"));
		let field = within(await screen.findByRole("dialog")).getByLabelText("Autre technologie");
		fireEvent.keyDown(field, { key: "Enter" });
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		fireEvent.change(field, { target: { value: " Hangfire " } });
		fireEvent.keyDown(field, { key: "a" });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(blocks()).toContain("worker Hangfire");

		fireEvent.click(paletteBlock("worker"));
		field = within(await screen.findByRole("dialog")).getByLabelText("Autre technologie");
		fireEvent.change(field, { target: { value: "Quartz" } });
		fireEvent.click(screen.getByRole("button", { name: "Utiliser" }));
		expect(blocks()).toContain("worker Quartz");

		fireEvent.click(paletteBlock("worker"));
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sans technologie" }));
		expect(blocks().filter((b) => b === "worker")).toHaveLength(1);

		const before = blocks().length;
		fireEvent.click(paletteBlock("worker"));
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Annuler" }));
		fireEvent.click(paletteBlock("worker"));
		fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(blocks()).toHaveLength(before);
	});

	it("places a block without a stack choice straight away, at the centre of the view", () => {
		render(<CanvasPanel />);
		fireEvent.click(paletteBlock("thirdPartyApi"));
		const placed = flow.props.nodes.at(-1) as Node;
		expect(placed.data).toMatchObject({ label: "thirdparty", type: "thirdparty" });
		expect(placed.position).toEqual({ x: 1, y: 1 });
	});

	it("drops a block under the cursor, and falls back to the pane before the canvas is ready", () => {
		render(<CanvasPanel />);
		const pane = screen.getByTestId("reactflow-canvas");
		dropAt(pane, "thirdparty", 40, 50);
		expect((flow.props.nodes.at(-1) as Node).position).toEqual({ x: 41, y: 51 });
		dropAt(pane, "");
		expect(flow.props.nodes).toHaveLength(3);
		// A type the palette does not know is placed under its own name.
		dropAt(pane, "quantum");
		expect((flow.props.nodes.at(-1) as Node).data).toMatchObject({ label: "quantum", type: "quantum" });

		const over = { dataTransfer: { dropEffect: "none" } };
		fireEvent.dragOver(pane, over);
		expect(over.dataTransfer.dropEffect).toBe("copy");
	});

	it("drops relative to the pane, and places by default in a cascade, without a ReactFlow instance", () => {
		flow.instance = null;
		render(<CanvasPanel />);
		const pane = screen.getByTestId("reactflow-canvas");
		dropAt(pane, "thirdparty", 40, 50);
		expect((flow.props.nodes.at(-1) as Node).position).toEqual({ x: 40, y: 50 });
		fireEvent.click(screen.getByRole("button", { name: "Bloc" }));
		expect((flow.props.nodes.at(-1) as Node).position).toEqual({ x: 160 + 40 * 3, y: 120 + 30 * 3 });
	});

	it("places one of the person's bricks, and nothing for a brick that is gone", () => {
		useCustomBricksStore.setState({
			bricks: [{ id: "hermes", name: "Hermes", kicker: "Agent", accent: "#f97316", icon: "bot", description: "", stack: "" }],
		});
		render(<CanvasPanel />);
		const pane = screen.getByTestId("reactflow-canvas");
		fireEvent.drop(pane, { dataTransfer: { getData: () => `${BRICK_DRAG_PREFIX}hermes` } });
		expect(blocks()).toContain("Hermes");
		fireEvent.drop(pane, { dataTransfer: { getData: () => `${BRICK_DRAG_PREFIX}gone` } });
		expect(blocks()).toHaveLength(3);
	});

	it("hides and shows the palette", () => {
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Palette" }));
		expect(screen.queryByLabelText("Rechercher un bloc…")).toBeNull();
		fireEvent.click(screen.getAllByTitle("Afficher/masquer la palette de blocs").at(-1) as HTMLElement);
		expect(screen.getByLabelText("Rechercher un bloc…")).toBeInTheDocument();
	});

	it("arranges the blocks and frames them", async () => {
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Organiser automatiquement" }));
		const [a, b] = flow.props.nodes as Node[];
		expect(a.position).not.toEqual(b.position);
		await waitFor(() => expect(flow.instance?.fitView).toHaveBeenCalledWith({ padding: 0.2, duration: 300 }));
	});
});

describe("CanvasPanel — selection, inspector and shortcuts", () => {
	beforeEach(() => {
		openOn(
			architecture(
				"a1",
				"Shop",
				[block("n1", "Orders API", "backend"), block("n2", "Orders DB", "database"), block("n3", "Cache", "cache")],
				[
					{ id: "e1", source: "n1", target: "n2", data: { label: "SQL" } },
					{ id: "e2", source: "n1", target: "n3", data: { label: "Redis" } },
				],
			),
		);
	});

	it("inspects the one block selected, renames it and deletes it with its connections", () => {
		render(<CanvasPanel />);
		canvasNodes([{ type: "select", id: "n1", selected: true }]);
		const name = screen.getByLabelText("Nom");
		fireEvent.change(name, { target: { value: "Billing API" } });
		expect(blocks()).toContain("Billing API");
		fireEvent.click(screen.getByRole("button", { name: "Supprimer le bloc" }));
		expect(blocks()).toEqual(["Orders DB", "Cache"]);
		expect(flow.props.edges).toEqual([]);
	});

	it("renames and deletes from the block itself", () => {
		render(<CanvasPanel />);
		act(() => flow.props.nodes[1].data.onRename("n2", "Ledger"));
		expect(blocks()).toContain("Ledger");
		act(() => flow.props.nodes[1].data.onDelete("n2"));
		expect(blocks()).toEqual(["Orders API", "Cache"]);
		expect(flow.props.edges.map((e: Edge) => e.id)).toEqual(["e2"]);
	});

	it("inspects one selected connection: its ends, its sentence, its relation", () => {
		render(<CanvasPanel />);
		act(() => flow.props.onEdgesChange([{ type: "select", id: "e1", selected: true }]));
		expect(screen.getByText("Interaction")).toBeInTheDocument();
		expect(screen.getAllByText("Orders API").length).toBeGreaterThan(1);
		fireEvent.change(screen.getByLabelText("Explication"), { target: { value: "Écrit les factures" } });
		expect(flow.props.edges[0].data).toMatchObject({ description: "Écrit les factures", explanation: "Écrit les factures" });
		fireEvent.click(screen.getByText("Revenir au texte automatique"));
		expect(flow.props.edges[0].data.description).toBeUndefined();
		fireEvent.click(screen.getByRole("button", { name: "Supprimer la connexion" }));
		expect(flow.props.edges.map((e: Edge) => e.id)).toEqual(["e2"]);
	});

	it("edits and deletes a connection from the canvas, dropping the fields set back to automatic", () => {
		render(<CanvasPanel />);
		act(() => flow.props.edges[0].data.onEdgeChange("e1", { color: "#10b981", description: "" }));
		expect(flow.props.edges[0].data).toMatchObject({ color: "#10b981", label: "SQL" });
		expect(flow.props.edges[0].data).not.toHaveProperty("description");
		act(() => flow.props.edges[0].data.onEdgeChange("e1", { color: null }));
		expect(flow.props.edges[0].data).not.toHaveProperty("color");
		expect(flow.props.edges[1].data.label).toBe("Redis");
		act(() => flow.props.edges[1].data.onDelete("e2"));
		expect(flow.props.edges).toHaveLength(1);
	});

	it("does not inspect a connection while blocks are selected", () => {
		render(<CanvasPanel />);
		canvasNodes([
			{ type: "select", id: "n1", selected: true },
			{ type: "select", id: "n2", selected: true },
		]);
		act(() => flow.props.onEdgesChange([{ type: "select", id: "e1", selected: true }]));
		expect(screen.queryByText("Interaction")).toBeNull();
		expect(screen.queryByLabelText("Nom")).toBeNull();
	});

	it("deletes the selection on Delete, with the links it leaves dangling", () => {
		render(<CanvasPanel />);
		canvasNodes([{ type: "select", id: "n3", selected: true }]);
		act(() => flow.props.onEdgesChange([{ type: "select", id: "e1", selected: true }]));
		fireEvent.keyDown(document.body, { key: "Delete" });
		expect(blocks()).toEqual(["Orders API", "Orders DB"]);
		expect(flow.props.edges).toEqual([]);
	});

	it("undoes and redoes by the toolbar and by Ctrl+Y and Ctrl+Shift+Z", async () => {
		render(<CanvasPanel />);
		// Nothing to undo yet: the shortcut changes nothing.
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(blocks()).toHaveLength(3);
		const undo = screen.getByRole("button", { name: "Annuler (Ctrl+Z)" });
		const redo = screen.getByRole("button", { name: "Rétablir (Ctrl+Maj+Z)" });
		fireEvent.click(screen.getByRole("button", { name: "Bloc" }));
		await waitFor(() => expect(undo).not.toBeDisabled(), { timeout: 2000 });
		fireEvent.click(undo);
		expect(blocks()).toHaveLength(3);
		expect(redo).not.toBeDisabled();
		fireEvent.click(redo);
		expect(blocks()).toHaveLength(4);
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		expect(blocks()).toHaveLength(3);
		fireEvent.keyDown(document.body, { key: "y", metaKey: true });
		expect(blocks()).toHaveLength(4);
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
		expect(blocks()).toHaveLength(4);
		// Nothing more to redo: the shortcut is a no-op, not an error.
		fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
		fireEvent.keyDown(document.body, { key: "a" });
		expect(blocks()).toHaveLength(4);
	});

	it("leaves the keys to a field, to a dialog, and to the other tab of the hub", async () => {
		render(<CanvasPanel />);
		canvasNodes([{ type: "select", id: "n3", selected: true }]);
		const editable = document.createElement("div");
		editable.contentEditable = "true";
		Object.defineProperty(editable, "isContentEditable", { value: true });
		document.body.append(editable);
		fireEvent.keyDown(editable, { key: "Backspace" });
		fireEvent.keyDown(screen.getByLabelText("Nom"), { key: "Backspace" });

		// The design-import tab is on screen: the canvas is behind it.
		act(() => useVisualToCodeStore.setState({ activeMode: "design-import" }));
		fireEvent.keyDown(document.body, { key: "Delete" });
		expect(blocks()).toContain("Cache");
		act(() => useVisualToCodeStore.setState({ activeMode: "canvas" }));

		// A button of a dialog over the canvas has the focus.
		fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.keyDown(within(dialog).getAllByRole("button")[0], { key: "Backspace" });
		expect(blocks()).toContain("Cache");
		editable.remove();
	});

	it("colours the minimap by block and grows it under the pointer or the focus", () => {
		const { container } = render(<CanvasPanel />);
		expect(flow.minimap.nodeColor({ data: { type: "database" } })).toMatch(/^#|var\(/);
		const holder = container.querySelector('[style*="z-index: 11"]') as HTMLElement;
		fireEvent.mouseEnter(holder);
		expect(flow.minimap.style.width).toBe(200);
		fireEvent.mouseLeave(holder);
		expect(flow.minimap.style.width).toBe(52);
		fireEvent.focus(holder);
		expect(flow.minimap.style.height).toBe(140);
		fireEvent.blur(holder);
		expect(flow.minimap.style.height).toBe(40);
	});

	it("switches the connections' sentences off", () => {
		render(<CanvasPanel />);
		const toggle = screen.getByRole("button", { name: "Interactions" });
		expect(flow.props.edges[0].data.showText).toBe(true);
		fireEvent.click(toggle);
		expect(flow.props.edges[0].data.showText).toBe(false);
		expect(toggle).toHaveAttribute("aria-pressed", "false");
	});

	it("names a connection's missing end with nothing", () => {
		openOn(
			architecture(
				"a1",
				"Shop",
				[block("n1", "Orders API")],
				[
					{ id: "e9", source: "n1", target: "ghost" },
					{ id: "e8", source: "ghost", target: "n1" },
				],
			),
		);
		render(<CanvasPanel />);
		act(() => flow.props.onEdgesChange([{ type: "select", id: "e9", selected: true }]));
		expect(screen.getByText("Interaction")).toBeInTheDocument();
		act(() =>
			flow.props.onEdgesChange([
				{ type: "select", id: "e9", selected: false },
				{ type: "select", id: "e8", selected: true },
			]),
		);
		expect(screen.getByText("Interaction")).toBeInTheDocument();
		expect(flow.props.edges[1].data.defaultExplanation).toEqual(expect.any(String));
	});

	it("warns on a selected connection whose stacks do not fit", () => {
		openOn(
			architecture(
				"a1",
				"Shop",
				[
					block("q", "Jobs", "queue", { data: { label: "Jobs", type: "queue", framework: "Kafka" } }),
					block("w", "Runner", "worker", { data: { label: "Runner", type: "worker", framework: "Celery" } }),
				],
				[{ id: "e", source: "q", target: "w" }],
			),
		);
		render(<CanvasPanel />);
		act(() => flow.props.onEdgesChange([{ type: "select", id: "e", selected: true }]));
		expect(screen.getByRole("alert")).toHaveTextContent(/Celery/);
	});

	it("names the brick a selected block is made from, while the brick exists", () => {
		useCustomBricksStore.setState({
			bricks: [{ id: "hermes", name: "Hermes", kicker: "Agent", accent: "#f97316", icon: "bot", description: "", stack: "" }],
		});
		openOn(
			architecture("a1", "Shop", [
				block("n1", "Hermes", "custom", { data: { label: "Hermes", type: "custom", brickId: "hermes" } }),
				block("n2", "Old", "custom", { data: { label: "Old", type: "custom", brickId: "deleted" } }),
			]),
		);
		render(<CanvasPanel />);
		canvasNodes([{ type: "select", id: "n1", selected: true }]);
		expect(screen.getByText(/viennent de la brique « Hermes »/)).toBeInTheDocument();
		canvasNodes([
			{ type: "select", id: "n1", selected: false },
			{ type: "select", id: "n2", selected: true },
		]);
		expect(screen.queryByText(/viennent de la brique/)).toBeNull();
	});
});

describe("CanvasPanel — the construction timeline", () => {
	it("records a step once editing settles", async () => {
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Bloc" }));
		await waitFor(() => expect(API.appendArchitectureVersion).toHaveBeenCalled(), { timeout: 3000 });
		const [id, version] = API.appendArchitectureVersion.mock.calls[0];
		expect(id).toBe("a1");
		expect(version.summary.addedNodes).toBe(1);
		expect(version.nodes).toHaveLength(3);
	});

	it("records no step for a relation renamed, which changes no block or link", async () => {
		openOn(architecture("a1", "Shop", [block("n1", "API"), block("n2", "DB")], [{ id: "e1", source: "n1", target: "n2", data: { label: "SQL" } }]));
		render(<CanvasPanel />);
		act(() => flow.props.edges[0].data.onEdgeChange("e1", { label: "JDBC" }));
		await new Promise((r) => setTimeout(r, 1700));
		expect(API.appendArchitectureVersion).not.toHaveBeenCalled();
	});

	it("takes a parked restore and a parked diagram once, even when effects run twice", () => {
		useVisualToCodeStore.setState({
			pendingRestore: { architectureId: "a1", versionId: "v0", nodes: [block("r", "Restored")], edges: [], diagramType: "architecture" },
			pendingDiagram: { nodes: [{ id: "x", label: "Imported", type: "backend" }], edges: [], summary: "Un bloc" },
		} as never);
		render(
			<React.StrictMode>
				<CanvasPanel />
			</React.StrictMode>,
		);
		expect(useVisualToCodeStore.getState().pendingRestore).toBeNull();
		expect(useVisualToCodeStore.getState().pendingDiagram).toBeNull();
		expect(vi.mocked(toast).mock.calls.map((c) => (c[0] as { title: string }).title).sort()).toEqual([
			"Diagramme généré !",
			"Étape restaurée",
		]);
	});

	it("records nothing for a change that is undone before the step is taken", async () => {
		render(<CanvasPanel />);
		act(() => flow.props.nodes[0].data.onRename("n1", "Billing"));
		act(() => flow.props.nodes[0].data.onRename("n1", "Orders API"));
		await new Promise((r) => setTimeout(r, 1700));
		expect(API.appendArchitectureVersion).not.toHaveBeenCalled();
	});

	it("reads the timeline when opened, then restores, names and deletes a step", async () => {
		const meta = { id: "v1", createdAt: new Date().toISOString(), label: null, pinned: false, nodeCount: 1, edgeCount: 0, summary: null, restoredFrom: null };
		API.listArchitectureVersions.mockResolvedValue({ success: true, data: [meta] });
		API.getArchitectureVersion.mockResolvedValue({
			success: true,
			data: { ...meta, diagramType: "flowchart", nodes: [block("r1", "Restored")], edges: [] },
		});
		API.labelArchitectureVersion.mockResolvedValue({ success: true, data: [{ ...meta, label: "Livrée" }] });
		API.deleteArchitectureVersion.mockResolvedValue({ success: true, data: [] });
		API.appendArchitectureVersion.mockResolvedValue({ success: true, data: [meta] });
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Historique" }));
		await waitFor(() => expect(API.listArchitectureVersions).toHaveBeenCalledWith("a1"));
		const dock = await screen.findByRole("complementary", { name: "Historique de construction" });

		fireEvent.click(await within(dock).findByRole("button", { name: /Restaurer/ }));
		await waitFor(() => expect(blocks()).toEqual(["Restored"]));
		expect(screen.getByLabelText("Type de diagramme")).toHaveValue("flowchart");
		expect(lastToast().title).toBe("Étape restaurée");
		await waitFor(() =>
			expect(API.appendArchitectureVersion).toHaveBeenCalledWith("a1", expect.objectContaining({ restoredFrom: "v1" })),
		);

		fireEvent.click(within(dock).getByRole("button", { name: "Nommer cette étape pour la conserver" }));
		const field = within(dock).getByLabelText("Nommer cette étape");
		fireEvent.change(field, { target: { value: "Livrée" } });
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(API.labelArchitectureVersion).toHaveBeenCalledWith("a1", "v1", "Livrée"));

		fireEvent.click(within(dock).getAllByRole("button", { name: "Supprimer cette étape" })[0]);
		await waitFor(() => expect(API.deleteArchitectureVersion).toHaveBeenCalledWith("a1", "v1"));

		fireEvent.click(within(dock).getByRole("button", { name: "Fermer" }));
		expect(useVisualToCodeStore.getState().historyOpen).toBe(false);
	});

	it("takes a restore that changes nothing without recording a step", async () => {
		render(<CanvasPanel />);
		act(() =>
			useVisualToCodeStore.setState({
				pendingRestore: {
					architectureId: "a1",
					versionId: "v0",
					nodes: doc("a1")?.nodes ?? [],
					edges: [],
					diagramType: "architecture",
				},
			}),
		);
		expect(lastToast().title).toBe("Étape restaurée");
		await new Promise((r) => setTimeout(r, 50));
		expect(API.appendArchitectureVersion).not.toHaveBeenCalled();
	});

	it("leaves a restore meant for another document parked", () => {
		render(<CanvasPanel />);
		act(() =>
			useVisualToCodeStore.setState({
				pendingRestore: { architectureId: "other", versionId: "v0", nodes: [], edges: [], diagramType: "architecture" },
			}),
		);
		expect(useVisualToCodeStore.getState().pendingRestore).not.toBeNull();
		expect(blocks()).toHaveLength(2);
	});

	it("ignores the history buttons when no document is active", () => {
		render(<CanvasPanel />);
		act(() => useVisualToCodeStore.setState({ historyOpen: true, activeArchitectureId: null, versions: [{ id: "v1", createdAt: "", label: null, pinned: false, nodeCount: 0, edgeCount: 0, summary: null, restoredFrom: null }] }));
		const dock = screen.getByRole("complementary", { name: "Historique de construction" });
		fireEvent.click(within(dock).getByRole("button", { name: /Restaurer/ }));
		fireEvent.click(within(dock).getByRole("button", { name: "Supprimer cette étape" }));
		fireEvent.click(within(dock).getByRole("button", { name: "Nommer cette étape pour la conserver" }));
		fireEvent.keyDown(within(dock).getByLabelText("Nommer cette étape"), { key: "Enter" });
		expect(API.getArchitectureVersion).not.toHaveBeenCalled();
		expect(API.deleteArchitectureVersion).not.toHaveBeenCalled();
		expect(API.labelArchitectureVersion).not.toHaveBeenCalled();
	});
});

describe("CanvasPanel — AI runs", () => {
	it("sends the diagram for a code preview", async () => {
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Aperçu du code" }));
		await waitFor(() => expect(API.runVisualProgramming).toHaveBeenCalled());
		const call = API.runVisualProgramming.mock.calls[0][0];
		expect(call.action).toBe("generate-code");
		expect(JSON.parse(call.diagramJson).nodes).toHaveLength(2);
		expect(useVisualToCodeStore.getState().phase).toBe("generating");
		expect(screen.getByRole("button", { name: "Génération…" })).toBeDisabled();
	});

	it("says so in the app's language when the bridge is missing", () => {
		const run = globalThis.electronAPI.runVisualProgramming;
		Object.assign(globalThis.electronAPI, { runVisualProgramming: undefined });
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Aperçu du code" }));
		expect(lastToast()).toMatchObject({ title: "IA non disponible", description: "Le pont vers l'application est absent." });
		pickFile(document.querySelector('input[accept^=".js"]') as HTMLElement, new File(["x"], "a.ts"));
		expect(vi.mocked(toast)).toHaveBeenCalledTimes(2);
		Object.assign(globalThis.electronAPI, { runVisualProgramming: run });
	});

	it("reads a source file into a diagram, and nothing when no file was picked", async () => {
		render(<CanvasPanel />);
		const input = document.querySelector('input[accept^=".js"]') as HTMLElement;
		fireEvent.click(screen.getByRole("button", { name: "Code → Visuel" }));
		pickFile(input, null);
		expect(API.runVisualProgramming).not.toHaveBeenCalled();
		const file = new File(["x"], "orders.ts");
		Object.defineProperty(file, "path", { value: "/src/orders.ts" });
		pickFile(input, file);
		await waitFor(() =>
			expect(API.runVisualProgramming).toHaveBeenCalledWith({ action: "code-to-visual", filePath: "/src/orders.ts" }),
		);
		pickFile(input, new File(["x"], "plain.ts"));
		await waitFor(() =>
			expect(API.runVisualProgramming).toHaveBeenLastCalledWith({ action: "code-to-visual", filePath: "plain.ts" }),
		);
	});

	it("lays out the diagram a reverse run answered, keeping the model's ids", () => {
		render(<CanvasPanel />);
		act(() =>
			useVisualToCodeStore.setState({
				pendingDiagram: {
					nodes: [
						{ id: "api", label: "API", type: "backend" },
						{ id: " ", label: "Web", type: "frontend" },
					],
					edges: [
						{ source: "imported-1", target: "api", label: "" },
						{ source: "api", target: "nowhere", label: "x" },
					],
					summary: "Deux blocs",
				},
			} as never),
		);
		expect(blocks()).toEqual(["API", "Web"]);
		expect(flow.props.edges).toEqual([expect.objectContaining({ source: "imported-1", target: "api" })]);
		expect(lastToast()).toMatchObject({ title: "Diagramme généré !", description: "Deux blocs — 1 connexion(s) ignorée(s)" });

		act(() =>
			useVisualToCodeStore.setState({ pendingDiagram: { nodes: [], edges: [], summary: "Vide" } } as never),
		);
		expect(lastToast().description).toBe("Vide");
	});

	it("reopens a dock the user closed while there is something behind it", () => {
		useVisualToCodeStore.setState({ streamedFiles: [{ filename: "a.ts", language: "ts", content: "" }], dockOpen: false });
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Code généré" }));
		expect(useVisualToCodeStore.getState().dockOpen).toBe(true);
	});
});

describe("CanvasPanel — handing the architecture to the build", () => {
	beforeEach(() => {
		API.getDefaultProjectLocation.mockResolvedValue("/home/me/projects");
		vi.mocked(createTask).mockResolvedValue({ id: "t1" } as never);
	});

	it("creates the task in the project the dialog named, and opens the Kanban", async () => {
		useProjectStore.setState({ projects: [{ id: "p1", name: "Shop", path: "/p1" } as never, { id: "p2", name: "Other", path: "/p2" } as never], activeProjectId: "p1" });
		const navigate = vi.fn();
		globalThis.addEventListener("workpilot:navigate-view", navigate);
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Scaffolder" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Shop")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: /Projet actif/ }));
		// The person switches project behind the dialog; the one shown is the target.
		useProjectStore.setState({ activeProjectId: "p2" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Générer le projet" }));
		await waitFor(() => expect(createTask).toHaveBeenCalled());
		const [projectId, title, , meta] = vi.mocked(createTask).mock.calls[0];
		expect(projectId).toBe("p1");
		expect(title).toBeTruthy();
		expect(meta).toEqual({ sourceType: "visual-canvas" });
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(lastToast().title).toBe("Tâche créée en Planification");
		globalThis.removeEventListener("workpilot:navigate-view", navigate);
	});

	it("says when the task could not be created", async () => {
		useProjectStore.setState({ projects: [{ id: "p1", name: "Shop", path: "/p1" } as never], activeProjectId: "p1" });
		vi.mocked(createTask).mockResolvedValue(null);
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Scaffolder" }));
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Générer le projet" }));
		await waitFor(() => expect(lastToast()?.title).toBe("Échec de la création de la tâche"));
	});

	it("creates a new project, named after the stacks, where the person chooses", async () => {
		openOn(
			architecture("a1", "Shop", [
				block("n1", "API", "backend", { data: { label: "API", type: "backend", framework: "FastApi" } }),
				block("n2", "Web", "frontend", { data: { label: "Web", type: "frontend", framework: "React" } }),
			]),
		);
		API.selectDirectory.mockResolvedValueOnce(null).mockResolvedValueOnce("/elsewhere");
		API.createProjectFolder
			.mockResolvedValueOnce({ success: false, error: "exists" })
			.mockResolvedValueOnce({ success: true, data: { path: "/elsewhere/fastapi-react" } })
			.mockResolvedValueOnce({ success: true, data: { path: "/elsewhere/fastapi-react" } });
		vi.mocked(addProject).mockResolvedValueOnce(null).mockResolvedValueOnce({ project: { id: "p9" } } as never);
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Scaffolder" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByRole("button", { name: /Projet actif/ })).toBeDisabled();
		expect(within(dialog).getByLabelText("Nom du projet")).toHaveValue("fastapi-react");
		await waitFor(() => expect(within(dialog).getByLabelText("Emplacement")).toHaveValue("/home/me/projects"));
		fireEvent.click(within(dialog).getByRole("button", { name: "Parcourir" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Parcourir" }));
		await waitFor(() => expect(within(dialog).getByLabelText("Emplacement")).toHaveValue("/elsewhere"));
		fireEvent.click(within(dialog).getByLabelText("Initialiser un dépôt Git"));
		fireEvent.change(within(dialog).getByLabelText("Nom du projet"), { target: { value: " fastapi-react " } });

		fireEvent.click(within(dialog).getByRole("button", { name: "Générer le projet" }));
		await waitFor(() => expect(lastToast()).toMatchObject({ title: "Échec de la création du projet", description: "exists" }));
		expect(API.createProjectFolder).toHaveBeenCalledWith("/elsewhere", "fastapi-react", false);

		const reopen = async () => {
			fireEvent.click(screen.getByRole("button", { name: "Scaffolder" }));
			const again = await screen.findByRole("dialog");
			fireEvent.click(within(again).getByRole("button", { name: "Générer le projet" }));
		};
		await reopen();
		await waitFor(() => expect(addProject).toHaveBeenCalledWith("/elsewhere/fastapi-react"));
		expect(lastToast().title).toBe("Échec de la création du projet");
		await reopen();
		await waitFor(() => expect(createTask).toHaveBeenCalledWith("p9", expect.any(String), expect.any(String), { sourceType: "visual-canvas" }));
	});

	it("names a project of stackless blocks after the diagram, keeps a location already chosen, and survives a failing default", async () => {
		API.getDefaultProjectLocation.mockRejectedValue(new Error("no home"));
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Scaffolder" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByLabelText("Nom du projet")).toHaveValue("architecture");
		expect(within(dialog).getByLabelText("Emplacement")).toHaveValue("");
		fireEvent.change(within(dialog).getByLabelText("Emplacement"), { target: { value: "/mine" } });
		fireEvent.change(within(dialog).getByLabelText("Nom du projet"), { target: { value: "!!!" } });
		fireEvent.click(within(dialog).getByRole("button", { name: /^Projet actif/ }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		fireEvent.change(screen.getByLabelText("Type de diagramme"), { target: { value: "mockup" } });
		fireEvent.click(screen.getByRole("button", { name: "Scaffolder" }));
		const again = await screen.findByRole("dialog");
		expect(within(again).getByLabelText("Emplacement")).toHaveValue("/mine");
		expect(API.getDefaultProjectLocation).toHaveBeenCalledTimes(1);
		fireEvent.click(within(again).getByRole("button", { name: /Nouveau projet/ }));
		expect(within(again).getByLabelText("Nom du projet")).toHaveValue("mockup");
	});

	it("falls back to a generic name when nothing in the diagram makes one", async () => {
		openOn(architecture("a1", "Shop", [block("n1", "A", "backend", { data: { label: "A", framework: "€€€" } })]));
		API.getDefaultProjectLocation.mockResolvedValue(null);
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Scaffolder" }));
		expect(within(await screen.findByRole("dialog")).getByLabelText("Nom du projet")).toHaveValue("mon-projet");
	});
});

describe("CanvasPanel — saving and loading files", () => {
	async function openSaveAs() {
		fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
		return screen.findByRole("dialog");
	}

	it("saves into a folder picked in the native picker, then marks the diagram saved", async () => {
		useProjectStore.setState({ projects: [{ id: "p1", name: "Shop", path: "/p1" } as never], activeProjectId: "p1" });
		API.selectDirectory.mockResolvedValueOnce(null).mockResolvedValueOnce("/work");
		API.saveJsonFile.mockResolvedValue({ success: true });
		render(<CanvasPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Bloc" }));
		const dialog = await openSaveAs();
		expect(within(dialog).getByLabelText("Racine de l'explorateur :")).toHaveValue("/p1");
		const save = within(dialog).getByRole("button", { name: "Sauvegarder dans le dossier sélectionné" });
		expect(save).toBeDisabled();
		fireEvent.click(within(dialog).getByRole("button", { name: "chooseFolder" }));
		await waitFor(() => expect(API.selectDirectory).toHaveBeenCalledWith({ defaultPath: "/p1" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "chooseFolder" }));
		await waitFor(() => expect(within(dialog).getByLabelText("Racine de l'explorateur :")).toHaveValue("/work"));
		fireEvent.click(within(dialog).getByRole("button", { name: "exports" }));
		expect(within(dialog).getByText(/\/work\/exports/)).toBeInTheDocument();
		fireEvent.change(within(dialog).getByLabelText("Nom du fichier :"), { target: { value: "shop.json" } });
		fireEvent.click(save);
		await waitFor(() => expect(API.saveJsonFile).toHaveBeenCalledWith("/work/exports", "shop.json", expect.objectContaining({ diagramType: "architecture" })));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByText("Enregistré")).toBeInTheDocument();
		expect(lastToast()).toMatchObject({ title: "Sauvegarde réussie", description: "Fichier sauvegardé dans /work/exports" });
	});

	it("reports a refused write, an unexplained one, a thrown one and a missing bridge", async () => {
		API.selectDirectory.mockResolvedValue("/work");
		API.saveJsonFile
			.mockResolvedValueOnce({ success: false, error: "read-only" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("disk gone"))
			.mockRejectedValueOnce("odd");
		render(<CanvasPanel />);
		const dialog = await openSaveAs();
		expect(within(dialog).getByText(/None|noFolder/)).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "chooseFolder" }));
		await waitFor(() => expect(within(dialog).getByText(/\/work/, { selector: "div" })).toBeInTheDocument());
		const save = within(dialog).getByRole("button", { name: "Sauvegarder dans le dossier sélectionné" });
		for (const description of ["read-only", "Erreur inconnue", "disk gone", "odd"]) {
			fireEvent.click(save);
			await waitFor(() => expect(lastToast()).toMatchObject({ title: "Erreur lors de la sauvegarde", description }));
		}
		const saveJson = globalThis.electronAPI.saveJsonFile;
		Object.assign(globalThis.electronAPI, { saveJsonFile: undefined });
		fireEvent.click(save);
		await waitFor(() => expect(lastToast().description).toBe("Le pont vers l'application est absent."));
		Object.assign(globalThis.electronAPI, { saveJsonFile: saveJson });

		fireEvent.change(within(dialog).getByLabelText("Nom du fichier :"), { target: { value: "  " } });
		expect(save).toBeDisabled();
		fireEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("closes the save dialog on Escape without writing", async () => {
		render(<CanvasPanel />);
		fireEvent.keyDown(await openSaveAs(), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(API.saveJsonFile).not.toHaveBeenCalled();
	});

	it("loads a diagram file as the saved state, and refuses one that is not", async () => {
		render(<CanvasPanel />);
		const input = document.querySelector('input[accept=".json"]') as HTMLElement;
		fireEvent.click(screen.getByRole("button", { name: "Charger" }));
		pickFile(input, null);
		const file = (content: string) => {
			const f = new File([content], "d.json");
			Object.defineProperty(f, "text", { value: () => Promise.resolve(content) });
			return f;
		};
		pickFile(
			input,
			file(
				JSON.stringify({
					diagramType: "flowchart",
					nodes: [{ id: "x", data: { label: "Loaded" } }, { data: { label: "No id" }, position: { x: 5, y: 5 } }],
					edges: [{ id: "le", source: "x", target: "loaded-1" }],
				}),
			),
		);
		await waitFor(() => expect(blocks()).toEqual(["Loaded", "No id"]));
		expect(flow.props.edges).toHaveLength(1);
		expect(screen.getByLabelText("Type de diagramme")).toHaveValue("flowchart");
		expect(screen.getByText("Enregistré")).toBeInTheDocument();
		await waitFor(() => expect(flow.instance?.fitView).toHaveBeenCalledWith({ padding: 0.2 }));

		pickFile(input, file(JSON.stringify({ diagramType: "poster", nodes: [] })));
		await waitFor(() => expect(blocks()).toEqual([]));
		expect(screen.getByLabelText("Type de diagramme")).toHaveValue("flowchart");

		for (const bad of ["{not json", JSON.stringify({ edges: [] })]) {
			pickFile(input, file(bad));
			await waitFor(() => expect(lastToast()).toMatchObject({ title: "Erreur de chargement" }));
			vi.mocked(toast).mockClear();
		}
	});
});
