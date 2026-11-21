/**
 * DefaultEdge — a connection on the architecture canvas: its relation and its
 * sentence, edited in place, reset and deleted from the chips beside it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { type EdgeProps, Position, ReactFlowProvider } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

// The label renderer portals into a live canvas, which jsdom cannot lay out;
// here it portals into the page, out of the <svg> (where an <input> would be
// created as an SVG node).
vi.mock("reactflow", async (importOriginal) => {
	const actual = await importOriginal<typeof import("reactflow")>();
	const { createPortal } = await import("react-dom");
	return {
		...actual,
		EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) =>
			createPortal(children, document.body),
	};
});

import { DefaultEdge, type DefaultEdgeData } from "../DefaultEdge";

const AUTO = "Orders API reads and writes its data in Orders DB";

function edgeProps(
	data: DefaultEdgeData | undefined,
	selected = false,
): EdgeProps<DefaultEdgeData> {
	return {
		id: "e1",
		source: "a",
		target: "b",
		sourceX: 0,
		sourceY: 0,
		targetX: 200,
		targetY: 80,
		sourcePosition: Position.Right,
		targetPosition: Position.Left,
		selected,
		data,
	} as EdgeProps<DefaultEdgeData>;
}

function renderEdge(
	data: Partial<DefaultEdgeData> | null,
	selected = false,
) {
	const onEdgeChange = vi.fn();
	const full =
		data === null
			? undefined
			: {
					label: "read / write",
					explanation: AUTO,
					defaultExplanation: AUTO,
					onEdgeChange,
					...data,
				};
	const view = (d: DefaultEdgeData | undefined) => (
		<ReactFlowProvider>
			<svg>
				<title>edge</title>
				<DefaultEdge {...edgeProps(d, selected)} />
			</svg>
		</ReactFlowProvider>
	);
	const utils = render(view(full));
	return {
		...utils,
		onEdgeChange,
		rerender: (d: DefaultEdgeData | undefined) => utils.rerender(view(d)),
	};
}

function openEditor() {
	fireEvent.doubleClick(
		screen.getByTitle("Double-click to edit the interaction"),
	);
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("DefaultEdge — wire and label", () => {
	it("writes the relation and the sentence, and marks the selected wire", () => {
		renderEdge({}, true);
		const label = screen.getByTitle("Double-click to edit the interaction");
		expect(label).toHaveTextContent("read / write");
		expect(label).toHaveTextContent(AUTO);
		expect(label).toHaveAttribute("data-selected", "true");
	});

	it("names a connection without a relation, and hides the sentence when switched off", () => {
		renderEdge({ label: "", showText: false });
		const label = screen.getByTitle("Double-click to edit the interaction");
		expect(label).toHaveTextContent("Interaction");
		expect(label).not.toHaveTextContent(AUTO);
		expect(label).toHaveAttribute("data-selected", "false");
	});

	it("draws a forced link dashed, in the wire's own colour", () => {
		const { container } = renderEdge({ forced: true, color: "#ff0000" });
		expect(container.querySelector(".vtc-edge-core")).toHaveStyle({
			strokeDasharray: "6 5",
		});
		expect(
			(container.querySelector("g.vtc-tint") as HTMLElement).style.getPropertyValue(
				"--vtc-flow",
			),
		).toBe("#ff0000");
	});

	it("ignores a colour that is not a hex accent", () => {
		const { container } = renderEdge({ color: "red" });
		expect(
			(container.querySelector("g.vtc-tint") as HTMLElement).style.getPropertyValue(
				"--vtc-flow",
			),
		).toBe("");
		expect(container.querySelector(".vtc-edge-core")).not.toHaveAttribute(
			"style",
		);
	});

	it("renders a connection that has no data at all", () => {
		renderEdge(null);
		expect(
			screen.getByTitle("Double-click to edit the interaction"),
		).toHaveTextContent("Interaction");
		expect(
			screen.queryByRole("button", { name: "Delete connection" }),
		).not.toBeInTheDocument();
		openEditor();
		fireEvent.change(screen.getByRole("textbox", { name: "Relation" }), {
			target: { value: "SQL" },
		});
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Relation" }), {
			key: "Enter",
		});
		openEditor();
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Relation" }), {
			key: "Escape",
		});
		expect(
			screen.getByTitle("Double-click to edit the interaction"),
		).toBeInTheDocument();
	});
});

describe("DefaultEdge — chips", () => {
	it("deletes the connection", () => {
		const onDelete = vi.fn();
		renderEdge({ onDelete });
		fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
		expect(onDelete).toHaveBeenCalledWith("e1");
	});

	it("returns a written sentence to the automatic one", () => {
		const { onEdgeChange } = renderEdge({
			description: "Stores paid orders",
			explanation: "Stores paid orders",
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Back to the automatic text" }),
		);
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { description: null });
	});

	it("offers no reset while the sentence is the automatic one", () => {
		renderEdge({});
		expect(
			screen.queryByRole("button", { name: "Back to the automatic text" }),
		).not.toBeInTheDocument();
	});
});

describe("DefaultEdge — editing", () => {
	it("opens on Enter or Space from the keyboard, focused on the relation", () => {
		renderEdge({});
		const label = screen.getByTitle("Double-click to edit the interaction");
		fireEvent.keyDown(label, { key: "a" });
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.keyDown(label, { key: " " });
		expect(screen.getByRole("textbox", { name: "Relation" })).toHaveFocus();
		expect(screen.getByText("Enter to confirm, Esc to cancel.")).toBeInTheDocument();
		expect(
			screen.getByRole("textbox", { name: "Explanation" }),
		).toHaveAttribute("placeholder", AUTO);
		// The chips are hidden while editing.
		expect(
			screen.queryByRole("button", { name: "Delete connection" }),
		).not.toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Relation" }), {
			key: "Escape",
		});
		fireEvent.keyDown(
			screen.getByTitle("Double-click to edit the interaction"),
			{ key: "Enter" },
		);
		expect(screen.getByRole("textbox", { name: "Relation" })).toBeInTheDocument();
	});

	it("saves the relation and the person's own sentence together", () => {
		const { onEdgeChange } = renderEdge({});
		openEditor();
		fireEvent.change(screen.getByRole("textbox", { name: "Relation" }), {
			target: { value: " SQL " },
		});
		const text = screen.getByRole("textbox", { name: "Explanation" });
		fireEvent.change(text, { target: { value: "Stores paid orders" } });
		fireEvent.keyDown(text, { key: "Enter" });
		expect(onEdgeChange).toHaveBeenCalledWith("e1", {
			label: "SQL",
			description: "Stores paid orders",
		});
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("keeps a new line on Shift+Enter instead of saving", () => {
		const { onEdgeChange } = renderEdge({});
		openEditor();
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Explanation" }), {
			key: "Enter",
			shiftKey: true,
		});
		expect(onEdgeChange).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Explanation" })).toBeInTheDocument();
	});

	it("does not save the automatic sentence as typed text, nor an unchanged edit", () => {
		const { onEdgeChange } = renderEdge({});
		openEditor();
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Relation" }), {
			key: "Enter",
		});
		expect(onEdgeChange).not.toHaveBeenCalled();
	});

	it("clears the person's sentence back to the automatic one", () => {
		const { onEdgeChange } = renderEdge({
			description: "Mine",
			explanation: "Mine",
		});
		openEditor();
		fireEvent.change(screen.getByRole("textbox", { name: "Explanation" }), {
			target: { value: "   " },
		});
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Explanation" }), {
			key: "Enter",
		});
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { description: null });
	});

	it("drops the edit on Escape and does not let keys reach the canvas", () => {
		const onCanvasKey = vi.fn();
		document.addEventListener("keydown", onCanvasKey);
		const { onEdgeChange } = renderEdge({});
		openEditor();
		const relation = screen.getByRole("textbox", { name: "Relation" });
		fireEvent.change(relation, { target: { value: "gRPC" } });
		fireEvent.keyDown(relation, { key: "Backspace" });
		fireEvent.keyDown(relation, { key: "Escape" });
		document.removeEventListener("keydown", onCanvasKey);
		expect(onCanvasKey).not.toHaveBeenCalled();
		expect(onEdgeChange).not.toHaveBeenCalled();
		openEditor();
		expect(screen.getByRole("textbox", { name: "Relation" })).toHaveValue(
			"read / write",
		);
	});

	it("saves when focus leaves the editor, not when it moves between its fields", () => {
		const { onEdgeChange } = renderEdge({});
		openEditor();
		const relation = screen.getByRole("textbox", { name: "Relation" });
		const text = screen.getByRole("textbox", { name: "Explanation" });
		fireEvent.change(relation, { target: { value: "SQL" } });
		fireEvent.blur(relation, { relatedTarget: text });
		expect(onEdgeChange).not.toHaveBeenCalled();
		fireEvent.blur(text, { relatedTarget: null });
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { label: "SQL" });
	});

	it("saves on submit of the form", () => {
		const { onEdgeChange } = renderEdge({});
		openEditor();
		const relation = screen.getByRole("textbox", { name: "Relation" });
		fireEvent.change(relation, { target: { value: "AMQP" } });
		fireEvent.submit(relation.closest("form") as HTMLFormElement);
		expect(onEdgeChange).toHaveBeenCalledWith("e1", { label: "AMQP" });
	});

	it("follows a relation changed elsewhere while not editing", () => {
		const { rerender, onEdgeChange } = renderEdge({});
		rerender({
			label: "HTTP",
			explanation: "Calls it",
			defaultExplanation: AUTO,
			onEdgeChange,
		});
		const label = screen.getByTitle("Double-click to edit the interaction");
		expect(label).toHaveTextContent("HTTP");
		expect(label).toHaveTextContent("Calls it");
		openEditor();
		expect(screen.getByRole("textbox", { name: "Relation" })).toHaveValue("HTTP");
		expect(screen.getByRole("textbox", { name: "Explanation" })).toHaveValue(
			"Calls it",
		);
	});
});
