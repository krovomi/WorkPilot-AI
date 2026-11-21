/**
 * EditableNode — a block on the architecture canvas: its role above its name,
 * double-click to rename, a delete button on hover.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { type NodeProps, ReactFlowProvider } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { EditableNode, type EditableNodeData } from "../EditableNode";

function nodeProps(
	data: EditableNodeData,
	selected = false,
): NodeProps<EditableNodeData> {
	return {
		id: "n1",
		data,
		selected,
		type: "editable",
		xPos: 0,
		yPos: 0,
		zIndex: 0,
		isConnectable: true,
		dragging: false,
	} as NodeProps<EditableNodeData>;
}

function renderNode(data: EditableNodeData, selected = false) {
	const utils = render(
		<ReactFlowProvider>
			<EditableNode {...nodeProps(data, selected)} />
		</ReactFlowProvider>,
	);
	const rerender = (next: EditableNodeData) =>
		utils.rerender(
			<ReactFlowProvider>
				<EditableNode {...nodeProps(next, selected)} />
			</ReactFlowProvider>,
		);
	return { ...utils, rerender };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("EditableNode — card", () => {
	it("shows the block's role from its palette type, its stack and its name", () => {
		const { container } = renderNode(
			{ label: "Orders API", type: "backend", framework: "FastAPI" },
			true,
		);
		expect(screen.getByText("Orders API")).toBeInTheDocument();
		expect(screen.getByText("BackEnd")).toBeInTheDocument();
		expect(screen.getByText("FastAPI")).toBeInTheDocument();
		expect(container.querySelector(".vtc-card")).toHaveAttribute(
			"data-selected",
			"true",
		);
	});

	it("shows the role and the hint a brick gave it, and no stack when none is chosen", () => {
		const { container } = renderNode({
			label: "Hermes",
			type: "custom",
			kicker: "Main agent",
			description: "Routes every request",
		});
		expect(screen.getByText("Main agent")).toBeInTheDocument();
		expect(container.querySelector(".vtc-card")).toHaveAttribute(
			"title",
			"Routes every request",
		);
		expect(container.querySelector(".vtc-stack")).toBeNull();
	});

	it("calls an untyped block a free block", () => {
		renderNode({ label: "Thing" });
		expect(screen.getByText("Free block")).toBeInTheDocument();
	});

	it("offers no delete button when the canvas cannot delete", () => {
		renderNode({ label: "Orders API", type: "backend" });
		expect(
			screen.queryByRole("button", { name: "Delete block" }),
		).not.toBeInTheDocument();
	});

	it("deletes the block from its button", () => {
		const onDelete = vi.fn();
		renderNode({ label: "Orders API", type: "backend", onDelete });
		fireEvent.click(screen.getByRole("button", { name: "Delete block" }));
		expect(onDelete).toHaveBeenCalledWith("n1");
	});
});

describe("EditableNode — rename", () => {
	it("renames on Enter, trimmed", () => {
		const onRename = vi.fn();
		renderNode({ label: "Orders API", type: "backend", onRename });
		fireEvent.doubleClick(screen.getByText("Orders API"));
		const input = screen.getByRole("textbox", { name: "Orders API" });
		fireEvent.change(input, { target: { value: "  Billing API " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).toHaveBeenCalledWith("n1", "Billing API");
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("renames when the field loses focus", () => {
		const onRename = vi.fn();
		renderNode({ label: "Orders API", type: "backend", onRename });
		fireEvent.doubleClick(screen.getByText("Orders API"));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Billing API" } });
		fireEvent.blur(input);
		expect(onRename).toHaveBeenCalledWith("n1", "Billing API");
	});

	it("keeps the old name when the new one is empty or unchanged", () => {
		const onRename = vi.fn();
		renderNode({ label: "Orders API", type: "backend", onRename });
		fireEvent.doubleClick(screen.getByText("Orders API"));
		let input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(screen.getByText("Orders API")).toBeInTheDocument();

		fireEvent.doubleClick(screen.getByText("Orders API"));
		input = screen.getByRole("textbox");
		expect(input).toHaveValue("Orders API");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("drops the edit on Escape", () => {
		const onRename = vi.fn();
		renderNode({ label: "Orders API", type: "backend", onRename });
		fireEvent.doubleClick(screen.getByText("Orders API"));
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "Billing" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByText("Orders API")).toBeInTheDocument();
		fireEvent.doubleClick(screen.getByText("Orders API"));
		expect(screen.getByRole("textbox")).toHaveValue("Orders API");
	});

	it("does not let a correction keystroke reach the canvas, which would delete the node", () => {
		// The canvas listens above the node; the event must stop at the field.
		const onCanvasKey = vi.fn();
		document.body.addEventListener("keydown", onCanvasKey);
		renderNode({ label: "Orders API" });
		fireEvent.doubleClick(screen.getByText("Orders API"));
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Backspace" });
		document.body.removeEventListener("keydown", onCanvasKey);
		expect(onCanvasKey).not.toHaveBeenCalled();
	});

	it("follows a rename made elsewhere on the canvas, and works without a label", () => {
		const { rerender } = renderNode({ label: "Orders API" });
		rerender({ label: "Billing API" });
		expect(screen.getByText("Billing API")).toBeInTheDocument();
		rerender({});
		fireEvent.doubleClick(screen.getByText("Free block"));
		const input = screen.getByRole("textbox");
		expect(input).toHaveValue("");
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.doubleClick(screen.getByText("Free block"));
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});
});
