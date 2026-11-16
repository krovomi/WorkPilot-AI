/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type React from "react";
import type { Edge, Node } from "reactflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
			const vars = (typeof fallback === "object" ? fallback : opts) ?? {};
			const raw = typeof fallback === "string" ? fallback : key;
			return raw.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(vars[n] ?? ""));
		},
		i18n: { language: "fr" },
	}),
}));

vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

// A toast's action is only clickable inside a live toaster; here it is a button.
vi.mock("../../ui/toast", () => ({
	ToastAction: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
		<button type="button" onClick={onClick}>
			{children}
		</button>
	),
}));

// The two panels are tested on their own; the hub is asked which one it shows.
vi.mock("../CanvasPanel", () => ({ CanvasPanel: () => <div data-testid="canvas-panel" /> }));
vi.mock("../design-import/SourceColumn", () => ({ SourceColumn: () => <div data-testid="source-column" /> }));
vi.mock("../design-import/PipelineGraph", () => ({ PipelineGraph: () => null }));
vi.mock("../design-import/ResultInspector", () => ({ ResultInspector: () => null }));
vi.mock("../design-import/DesignComposer", () => ({ DesignComposer: () => null }));
vi.mock("../design-import/design-import.css", () => ({}));
vi.mock("../../../stores/design-to-code-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../stores/design-to-code-store")>();
	return { ...actual, detectDesignStack: vi.fn(async () => undefined) };
});

import { toast } from "@/hooks/use-toast";
import { detectDesignStack, useDesignToCodeStore } from "../../../stores/design-to-code-store";
import { useProjectStore } from "../../../stores/project-store";
import { useVisualToCodeStore } from "../../../stores/visual-to-code-store";
import { ArchitectureChecks } from "../ArchitectureChecks";
import { DesignImportPanel } from "../DesignImportPanel";
import { edgeRelationOptions, edgeStackWarnings, useConnectBlocks } from "../useConnectBlocks";
import { useFitViewOnShow } from "../useFitViewOnShow";
import { VisualToCodeHub } from "../VisualToCodeHub";

function block(id: string, type: string, framework?: string, label = id): Node {
	return { id, position: { x: 0, y: 0 }, data: { label, type, framework } };
}

/** The edges, as ReactFlow's functional `setEdges` would keep them. */
function edgeState(initial: Edge[] = []) {
	let edges = initial;
	const setEdges = vi.fn((update: (eds: Edge[]) => Edge[]) => {
		edges = update(edges);
	});
	return { setEdges, current: () => edges };
}

/** The last toast's action, rendered so its buttons can be pressed. */
function renderLastToastAction() {
	const call = vi.mocked(toast).mock.calls.at(-1)?.[0] as { action: React.ReactElement };
	render(call.action);
}

beforeEach(() => vi.resetAllMocks());

describe("useConnectBlocks", () => {
	it("links a coherent pair straight away, with its relation", () => {
		const nodes = [block("web", "frontend"), block("api", "backend")];
		const state = edgeState();
		const { result } = renderHook(() => useConnectBlocks(nodes, [], state.setEdges, "fr"));
		result.current({ source: "web", target: "api", sourceHandle: null, targetHandle: null });
		expect(state.current()).toHaveLength(1);
		expect(state.current()[0]).toMatchObject({ source: "web", target: "api" });
		expect(state.current()[0].data.label).toBeTruthy();
		expect(toast).not.toHaveBeenCalled();
	});

	it("keeps a link whose stacks do not fit, and says so", () => {
		const nodes = [block("q", "queue", "Kafka"), block("w", "worker", "Celery")];
		const state = edgeState();
		const { result } = renderHook(() => useConnectBlocks(nodes, [], state.setEdges, "fr"));
		result.current({ source: "q", target: "w", sourceHandle: null, targetHandle: null });
		expect(state.current()).toHaveLength(1);
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Lien ajouté, mais les technologies ne collent pas",
				description: expect.stringContaining("Celery"),
			}),
		);
	});

	it("refuses to draw the same connection twice", () => {
		const nodes = [block("web", "frontend"), block("api", "backend")];
		const existing = [{ id: "e", source: "web", target: "api" }];
		const state = edgeState(existing);
		const { result } = renderHook(() => useConnectBlocks(nodes, existing, state.setEdges, "fr"));
		result.current({ source: "web", target: "api", sourceHandle: null, targetHandle: null });
		expect(state.setEdges).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Connexion déjà présente" }));
	});

	it("explains an unusual pair, names what goes between in the canvas' language, and links it anyway", () => {
		const nodes = [block("web", "frontend", undefined, "Web"), block("db", "database", undefined, "Orders DB")];
		const state = edgeState();
		const { result } = renderHook(() => useConnectBlocks(nodes, [], state.setEdges, "fr"));
		result.current({ source: "web", target: "db", sourceHandle: null, targetHandle: null });
		expect(state.current()).toEqual([]);
		const shown = vi.mocked(toast).mock.calls[0][0] as { title: string; description: string };
		expect(shown.title).toBe("Connexion inhabituelle");
		expect(shown.description).toContain("(Web → Orders DB)");
		// "A ou B", from the language's own list format.
		expect(shown.description).toContain("À intercaler : backend ou gateway.");

		renderLastToastAction();
		expect(screen.queryByRole("button", { name: "Inverser le sens" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Relier quand même" }));
		expect(state.current()).toHaveLength(1);
		expect(state.current()[0].data).toMatchObject({ forced: true });
		// Pressed twice, it still makes one link.
		fireEvent.click(screen.getByRole("button", { name: "Relier quand même" }));
		expect(state.current()).toHaveLength(1);
	});

	it("joins the in-between blocks in English for an English canvas", () => {
		const nodes = [block("web", "frontend"), block("db", "database")];
		const { result } = renderHook(() => useConnectBlocks(nodes, [], edgeState().setEdges, "en"));
		result.current({ source: "web", target: "db", sourceHandle: null, targetHandle: null });
		const shown = vi.mocked(toast).mock.calls[0][0] as { description: string };
		expect(shown.description).toContain("backend or gateway");
	});

	it("offers to flip a link drawn backwards, once", () => {
		const nodes = [block("db", "database"), block("api", "backend")];
		const state = edgeState();
		const { result } = renderHook(() => useConnectBlocks(nodes, [], state.setEdges, "fr"));
		result.current({ source: "db", target: "api", sourceHandle: null, targetHandle: null });
		const shown = vi.mocked(toast).mock.calls[0][0] as { description: string };
		expect(shown.description).not.toContain("À intercaler");

		renderLastToastAction();
		fireEvent.click(screen.getByRole("button", { name: "Inverser le sens" }));
		expect(state.current()).toEqual([
			expect.objectContaining({ id: "reactflow__edge-api-db", source: "api", target: "db" }),
		]);
		fireEvent.click(screen.getByRole("button", { name: "Inverser le sens" }));
		expect(state.current()).toHaveLength(1);
	});

	it("links a block it cannot find freely: an untyped end follows no rule", () => {
		const nodes = [block("db", "database")];
		const state = edgeState();
		const { result } = renderHook(() => useConnectBlocks(nodes, [], state.setEdges, "fr"));
		result.current({ source: "ghost", target: "db", sourceHandle: null, targetHandle: null });
		result.current({ source: "db", target: "phantom", sourceHandle: null, targetHandle: null });
		expect(state.current()).toEqual([
			expect.objectContaining({ source: "ghost", target: "db" }),
			expect.objectContaining({ source: "db", target: "phantom" }),
		]);
		expect(toast).not.toHaveBeenCalled();
	});
});

describe("edge relations and stack warnings", () => {
	const nodes = [block("q", "queue", "Kafka"), block("w", "worker", "Celery")];
	const edge: Edge = { id: "e", source: "q", target: "w" };

	it("offers the relations usual between the edge's two blocks", () => {
		expect(edgeRelationOptions(nodes, edge, "fr").length).toBeGreaterThan(0);
		expect(edgeRelationOptions(nodes, null, "fr")).toEqual([]);
	});

	it("says what does not fit between their stacks", () => {
		const warnings = edgeStackWarnings(nodes, edge, "fr", (s) => s.toUpperCase());
		expect(warnings.join(" ")).toContain("KAFKA");
		expect(edgeStackWarnings(nodes, null, "fr", (s) => s)).toEqual([]);
		expect(edgeStackWarnings([], edge, "fr", (s) => s)).toEqual([]);
	});
});

describe("ArchitectureChecks", () => {
	const setNodes = vi.fn();
	const setEdges = vi.fn();

	it("says nothing about an empty canvas", () => {
		const { container } = render(
			<ArchitectureChecks nodes={[]} edges={[]} lang="fr" setNodes={setNodes} setEdges={setEdges} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("calls a diagram without findings coherent", () => {
		render(
			<ArchitectureChecks
				nodes={[block("web", "frontend"), block("api", "backend")]}
				edges={[{ id: "e", source: "web", target: "api" }]}
				lang="fr"
				setNodes={setNodes}
				setEdges={setEdges}
			/>,
		);
		expect(screen.getByText("Architecture cohérente")).toBeInTheDocument();
	});

	it("lists the findings, warnings first, and selects what one is about", async () => {
		const nodes = [block("a", "microservice"), block("b", "microservice"), block("db", "database"), block("web", "frontend")];
		const edges: Edge[] = [
			{ id: "e1", source: "a", target: "db" },
			{ id: "e2", source: "b", target: "db" },
			{ id: "e3", source: "web", target: "db", data: { forced: true } },
		];
		render(<ArchitectureChecks nodes={nodes} edges={edges} lang="fr" setNodes={setNodes} setEdges={setEdges} />);
		const trigger = screen.getByRole("button", { name: /Points d'attention/ });
		expect(trigger).toHaveClass("text-warning");
		fireEvent.click(trigger);
		expect(await screen.findByText("Cohérence de l'architecture")).toBeInTheDocument();
		const items = screen.getAllByRole("listitem");
		expect(items.length).toBeGreaterThanOrEqual(2);
		fireEvent.click(items[0].querySelector("button") as HTMLButtonElement);

		const nodeUpdate = setNodes.mock.calls[0][0] as (ns: Node[]) => Node[];
		expect(nodeUpdate(nodes).filter((n) => n.selected).map((n) => n.id)).toEqual(["a", "b", "db"]);
		const edgeUpdate = setEdges.mock.calls[0][0] as (es: Edge[]) => Edge[];
		expect(edgeUpdate(edges).some((e) => e.selected)).toBe(false);

		fireEvent.click(items.at(-1)?.querySelector("button") as HTMLButtonElement);
		const forcedUpdate = setEdges.mock.calls[1][0] as (es: Edge[]) => Edge[];
		expect(forcedUpdate(edges).filter((e) => e.selected).map((e) => e.id)).toEqual(["e3"]);
	});

	it("reports stacks that do not fit on a link", async () => {
		render(
			<ArchitectureChecks
				nodes={[block("q", "queue", "Kafka"), block("w", "worker", "Celery")]}
				edges={[{ id: "e", source: "q", target: "w" }]}
				lang="fr"
				setNodes={setNodes}
				setEdges={setEdges}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Points d'attention/ }));
		expect(await screen.findByText(/Celery consomme/)).toBeInTheDocument();
	});

	it("marks a list of mere remarks as information", () => {
		render(
			<ArchitectureChecks
				nodes={[block("web", "frontend"), block("db", "database")]}
				edges={[{ id: "e3", source: "web", target: "db", data: { forced: true } }]}
				lang="fr"
				setNodes={setNodes}
				setEdges={setEdges}
			/>,
		);
		expect(screen.getByRole("button", { name: /Points d'attention/ })).toHaveClass("text-muted-foreground");
	});
});

describe("useFitViewOnShow", () => {
	afterEach(() => vi.useRealTimers());

	it("frames the diagram once the canvas is shown, and not while it is hidden", () => {
		vi.useFakeTimers();
		const fitView = vi.fn();
		const ref = { current: { fitView } };
		useVisualToCodeStore.setState({ activeMode: "design-import" });
		const { rerender, unmount } = renderHook(({ id }) => useFitViewOnShow(ref, id), {
			initialProps: { id: "arch-1" as string | null },
		});
		vi.advanceTimersByTime(500);
		expect(fitView).not.toHaveBeenCalled();

		act(() => useVisualToCodeStore.setState({ activeMode: "canvas" }));
		vi.advanceTimersByTime(250);
		expect(fitView).toHaveBeenCalledWith({ padding: 0.15, maxZoom: 1 });

		// A document switch frames again; one closed before the delay does not.
		rerender({ id: "arch-2" });
		unmount();
		vi.advanceTimersByTime(500);
		expect(fitView).toHaveBeenCalledTimes(1);
	});

	it("waits for a document", () => {
		vi.useFakeTimers();
		const fitView = vi.fn();
		useVisualToCodeStore.setState({ activeMode: "canvas" });
		renderHook(() => useFitViewOnShow({ current: { fitView } }, null));
		vi.advanceTimersByTime(500);
		expect(fitView).not.toHaveBeenCalled();
	});
});

describe("VisualToCodeHub", () => {
	it("keeps both panels mounted and shows the tab picked", () => {
		useVisualToCodeStore.setState({ activeMode: "design-import" });
		useProjectStore.setState({ selectedProjectId: null });
		render(<VisualToCodeHub />);
		const canvasPane = screen.getByTestId("canvas-panel").parentElement as HTMLElement;
		const designPane = screen.getByTestId("design-import").parentElement as HTMLElement;
		expect(designPane).toHaveStyle({ display: "flex" });
		expect(canvasPane).toHaveStyle({ display: "none" });

		fireEvent.click(screen.getByRole("button", { name: "tabs.canvas" }));
		expect(useVisualToCodeStore.getState().activeMode).toBe("canvas");
		expect(canvasPane).toHaveStyle({ display: "flex" });
		expect(designPane).toHaveStyle({ display: "none" });

		fireEvent.click(screen.getByRole("button", { name: "tabs.designImport" }));
		expect(useVisualToCodeStore.getState().activeMode).toBe("design-import");
	});
});

describe("DesignImportPanel", () => {
	it("starts over with the stack of another project, and keeps the run of the same one", () => {
		useDesignToCodeStore.setState({ projectId: "old", phase: "idle", stackChosen: true });
		const resetPipeline = vi.fn();
		useDesignToCodeStore.setState({ resetPipeline });
		useProjectStore.setState({ selectedProjectId: "p1" });
		const { unmount } = render(<DesignImportPanel />);
		expect(useDesignToCodeStore.getState()).toMatchObject({ projectId: "p1", stackChosen: false, detection: null });
		expect(resetPipeline).toHaveBeenCalledTimes(1);
		expect(detectDesignStack).toHaveBeenCalledWith("p1");
		unmount();

		render(<DesignImportPanel />);
		expect(detectDesignStack).toHaveBeenCalledTimes(1);
	});

	it("does not wipe a run still going when the project changes", () => {
		const resetPipeline = vi.fn();
		useDesignToCodeStore.setState({ projectId: "p1", phase: "analyzing", resetPipeline });
		useProjectStore.setState({ selectedProjectId: "p2" });
		render(<DesignImportPanel />);
		expect(resetPipeline).not.toHaveBeenCalled();
		expect(detectDesignStack).toHaveBeenCalledWith("p2");
	});
});
