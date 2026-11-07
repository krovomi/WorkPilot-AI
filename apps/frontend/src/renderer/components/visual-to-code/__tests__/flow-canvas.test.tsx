/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import type { EdgeProps } from "reactflow";
import { Position } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
			const raw = typeof fallback === "string" ? fallback : key;
			const vars = typeof fallback === "object" ? fallback : opts;
			return raw.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(vars?.[n] ?? ""));
		},
		i18n: { language: "fr" },
	}),
}));

// The label renderer portals into a live canvas; here it portals into the
// page, out of the <svg> (where an <input> would be created as an SVG node).
vi.mock("reactflow", async (importOriginal) => {
	const actual = await importOriginal<typeof import("reactflow")>();
	const { createPortal } = await import("react-dom");
	return {
		...actual,
		EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) =>
			createPortal(children, document.body),
		BaseEdge: () => null,
	};
});

import { useCustomBricksStore } from "../../../stores/custom-bricks-store";
import { DefaultEdge, type DefaultEdgeData } from "../../DefaultEdge";
import { BrickEditorDialog } from "../BrickEditorDialog";
import { CanvasInspector } from "../CanvasInspector";

function renderEdge(data: Partial<DefaultEdgeData>) {
	const onEdgeChange = vi.fn();
	const props = {
		id: "e1",
		source: "a",
		target: "b",
		sourceX: 0,
		sourceY: 0,
		targetX: 200,
		targetY: 80,
		sourcePosition: Position.Right,
		targetPosition: Position.Left,
		selected: false,
		data: {
			label: "lit / écrit",
			explanation: "Orders API lit et écrit ses données dans Orders DB",
			defaultExplanation: "Orders API lit et écrit ses données dans Orders DB",
			onEdgeChange,
			...data,
		},
	} as unknown as EdgeProps<DefaultEdgeData>;
	render(
		<svg>
			<title>edge</title>
			<DefaultEdge {...props} />
		</svg>,
	);
	return onEdgeChange;
}

describe("DefaultEdge", () => {
	it("writes the relation and the sentence between the two blocks", () => {
		renderEdge({});
		expect(screen.getByText("lit / écrit")).toBeInTheDocument();
		expect(
			screen.getByText("Orders API lit et écrit ses données dans Orders DB"),
		).toBeInTheDocument();
	});

	it("hides the sentence when the explanations are switched off", () => {
		renderEdge({ showText: false });
		expect(screen.queryByText(/lit et écrit ses données/)).not.toBeInTheDocument();
	});

	it("keeps the person's own sentence when they write one", () => {
		const onEdgeChange = renderEdge({});
		fireEvent.doubleClick(screen.getByText("lit / écrit"));
		const text = screen.getByLabelText("Explication");
		fireEvent.change(text, { target: { value: "Stocke les commandes validées" } });
		fireEvent.keyDown(text, { key: "Enter" });
		expect(onEdgeChange).toHaveBeenCalledWith("e1", {
			description: "Stocke les commandes validées",
		});
	});

	it("goes back to the automatic sentence when theirs is cleared", () => {
		const onEdgeChange = renderEdge({
			description: "Mon texte",
			explanation: "Mon texte",
		});
		fireEvent.doubleClick(screen.getByText("lit / écrit"));
		const text = screen.getByLabelText("Explication");
		fireEvent.change(text, { target: { value: "  " } });
		fireEvent.keyDown(text, { key: "Enter" });
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { description: null });
	});

	it("does not freeze the automatic sentence as typed text", () => {
		const onEdgeChange = renderEdge({});
		fireEvent.doubleClick(screen.getByText("lit / écrit"));
		const relation = screen.getByLabelText("Relation");
		fireEvent.change(relation, { target: { value: "SQL" } });
		fireEvent.keyDown(relation, { key: "Enter" });
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { label: "SQL" });
	});
});

describe("BrickEditorDialog", () => {
	beforeEach(() => useCustomBricksStore.setState({ bricks: [] }));

	it("creates a brick the palette can place", () => {
		const onOpenChange = vi.fn();
		render(<BrickEditorDialog open brick={null} onOpenChange={onOpenChange} />);
		const create = screen.getByRole("button", { name: "Créer la brique" });
		expect(create).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Hermes" } });
		fireEvent.change(screen.getByLabelText("Rôle (au-dessus du nom)"), {
			target: { value: "Agent principal" },
		});
		fireEvent.click(screen.getByRole("button", { name: "#3b82f6" }));
		fireEvent.click(screen.getByRole("button", { name: "bot" }));
		fireEvent.click(create);
		expect(useCustomBricksStore.getState().bricks).toMatchObject([
			{ name: "Hermes", kicker: "Agent principal", accent: "#3b82f6", icon: "bot" },
		]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("CanvasInspector", () => {
	const noop = vi.fn();

	it("edits a connection's sentence and offers the way back to the automatic one", () => {
		const onEdgeChange = vi.fn();
		render(
			<CanvasInspector
				node={null}
				edge={{ id: "e1", source: "a", target: "b", data: { label: "MCP", description: "Résume" } }}
				edgeEnds={["Orders API", "Hermes"]}
				defaultExplanation="Orders API échange avec Hermes"
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={onEdgeChange}
				onDeleteEdge={noop}
			/>,
		);
		expect(screen.getByText("Orders API")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Revenir au texte automatique"));
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { description: null });
		fireEvent.click(screen.getByRole("button", { name: "#10b981" }));
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { color: "#10b981" });
	});

	it("offers the relations of the pair in a drop-down, then a free-text entry", () => {
		const onEdgeChange = vi.fn();
		render(
			<CanvasInspector
				node={null}
				edge={{ id: "e1", source: "a", target: "b", data: { label: "HTTP / REST" } }}
				edgeEnds={["BackEnd DotNet", "Worker DotNet"]}
				defaultExplanation=""
				relationOptions={["HTTP / REST", "gRPC", "MassTransit"]}
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={onEdgeChange}
				onDeleteEdge={noop}
			/>,
		);
		const select = screen.getByLabelText("Relation") as HTMLSelectElement;
		expect(select.tagName).toBe("SELECT");
		expect([...select.options].map((o) => o.textContent)).toEqual([
			"HTTP / REST",
			"gRPC",
			"MassTransit",
			"Autre (saisie libre)…",
		]);
		fireEvent.change(select, { target: { value: "gRPC" } });
		expect(onEdgeChange).toHaveBeenLastCalledWith("e1", { label: "gRPC" });
		expect(screen.queryByLabelText("Relation personnalisée")).toBeNull();

		fireEvent.change(select, { target: { value: select.options[3].value } });
		expect(onEdgeChange).toHaveBeenLastCalledWith("e1", { label: "" });
		const own = screen.getByLabelText("Relation personnalisée");
		fireEvent.change(own, { target: { value: "Webhook signé" } });
		expect(onEdgeChange).toHaveBeenLastCalledWith("e1", { label: "Webhook signé" });
	});

	it("keeps a relation the list does not know in the free-text entry", () => {
		render(
			<CanvasInspector
				node={null}
				edge={{ id: "e1", source: "a", target: "b", data: { label: "MCP", forced: true } }}
				edgeEnds={["Orders DB", "Web"]}
				defaultExplanation=""
				relationOptions={["relié à", "HTTP / REST"]}
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		expect(screen.getByLabelText("Relation personnalisée")).toHaveValue("MCP");
		expect(screen.getByText(/hors des règles d'architecture/)).toBeInTheDocument();
	});

	it("leaves a brick's role to the brick", () => {
		render(
			<CanvasInspector
				node={{
					id: "n1",
					position: { x: 0, y: 0 },
					data: { label: "Hermes", type: "custom", brickId: "b1", kicker: "Agent" },
				}}
				brickName="Hermes"
				edge={null}
				edgeEnds={null}
				defaultExplanation=""
				onNodeChange={noop}
				onDeleteNode={noop}
				onEdgeChange={noop}
				onDeleteEdge={noop}
			/>,
		);
		expect(screen.getByLabelText("Rôle affiché")).toBeDisabled();
		expect(screen.getByText(/viennent de la brique « Hermes »/)).toBeInTheDocument();
	});
});
