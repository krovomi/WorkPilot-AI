import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: string) => {
			const translations: Record<string, string> = {
				newDiagram: "New diagram",
				newFlowchart: "New Flowchart",
				newArchitectureDiagram: "New Architecture Diagram",
				newMockup: "New Mockup",
				addBlock: "Add block",
				reverse: "Reverse: Code → Visual",
				generateCode: "Generate code",
				scaffold: "Generate project",
				codePreview: "Code preview",
				export: "Export JSON",
				saveAs: "Save as\u2026",
				load: "Load",
				chooseFramework: "Choose framework or language",
				chooseFileName: "Export file name",
				customBlockPrompt: "Custom block name?",
			};
			return translations[key] ?? fallback ?? key;
		},
		i18n: { language: "en", changeLanguage: vi.fn() },
	}),
}));

vi.mock("reactflow", async () => {
	const React = await import("react");
	return {
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
		addEdge: vi.fn((params: unknown, eds: unknown[]) => [...eds, params]),
		useNodesState: (initial: unknown[]) => [initial, vi.fn(), vi.fn()],
		useEdgesState: (initial: unknown[]) => [initial, vi.fn(), vi.fn()],
	};
});

vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

vi.mock("@/stores/visual-to-code-store", () => ({
	useVisualToCodeStore: () => ({
		canvasNodes: [
			{
				id: "1",
				position: { x: 250, y: 5 },
				data: { label: "New Flowchart" },
				type: "editable",
			},
		],
		canvasEdges: [],
		canvasDiagramType: "flowchart",
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
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		(globalThis as any).electronAPI = {
			// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
			...(globalThis as any).electronAPI,
			onVisualProgrammingStatus: vi.fn(() => vi.fn()),
			onVisualProgrammingError: vi.fn(() => vi.fn()),
			onVisualProgrammingComplete: vi.fn(() => vi.fn()),
			runVisualProgramming: vi.fn().mockResolvedValue({ success: true }),
			saveJsonFile: vi.fn().mockResolvedValue({ success: true }),
			getUserHome: vi.fn().mockResolvedValue("/home/user"),
		};
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		(globalThis as any).platform = { isWindows: false };
	});

	it("renders a single 'New diagram' button (consolidated types)", () => {
		render(<CanvasPanel />);
		expect(
			screen.getByRole("button", { name: "New diagram" }),
		).toBeInTheDocument();
		// The old flowchart/mockup presets are gone.
		expect(screen.queryByText("New Mockup")).not.toBeInTheDocument();
	});

	it("renders action buttons", () => {
		render(<CanvasPanel />);
		expect(screen.getByText("Add block")).toBeInTheDocument();
		expect(screen.getByText("Reverse: Code \u2192 Visual")).toBeInTheDocument();
		// Primary action: full agentic scaffold; secondary: one-shot code preview
		expect(screen.getByText("Generate project")).toBeInTheDocument();
		expect(screen.getByText("Code preview")).toBeInTheDocument();
		expect(screen.getByText("Export JSON")).toBeInTheDocument();
		expect(screen.getByText("Save as\u2026")).toBeInTheDocument();
		expect(screen.getByText("Load")).toBeInTheDocument();
	});

	it("renders the ReactFlow canvas", () => {
		render(<CanvasPanel />);
		expect(screen.getByTestId("reactflow-canvas")).toBeInTheDocument();
	});

	it("Generate-project and Code-preview buttons are enabled when diagram has nodes", () => {
		render(<CanvasPanel />);
		// Initial state has 1 node (the default New Flowchart node), so both are enabled
		expect(
			screen.getByRole("button", { name: "Generate project" }),
		).not.toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Code preview" }),
		).not.toBeDisabled();
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
		// on every render and wrote a new value each time → "Maximum update depth
		// exceeded". The fix runs it only when the dialog opens.
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
