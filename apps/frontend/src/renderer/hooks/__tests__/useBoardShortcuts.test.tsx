import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBoardShortcuts } from "../useBoardShortcuts";

function Board({ hasSelection = false, ...handlers }: Partial<Parameters<typeof useBoardShortcuts>[0]>) {
	const shortcuts = {
		onSelectColumn: vi.fn(),
		onClearSelection: vi.fn(),
		onDeleteSelection: vi.fn(),
		onUndo: vi.fn(),
		...handlers,
		hasSelection,
	};
	useBoardShortcuts(shortcuts);
	return (
		<div>
			<div data-column-status="backlog">
				<button type="button">in backlog</button>
			</div>
			<div data-column-status="queue">
				<span>in queue</span>
			</div>
			<input aria-label="search" />
		</div>
	);
}

function setup(props: Partial<Parameters<typeof useBoardShortcuts>[0]> = {}) {
	const handlers = {
		onSelectColumn: vi.fn(),
		onClearSelection: vi.fn(),
		onDeleteSelection: vi.fn(),
		onUndo: vi.fn(),
	};
	render(<Board {...handlers} {...props} />);
	return handlers;
}

describe("useBoardShortcuts", () => {
	it("selects the column under the focus, else under the pointer", () => {
		const handlers = setup();
		fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
		expect(handlers.onSelectColumn).not.toHaveBeenCalled();
		fireEvent.pointerOver(screen.getByText("in queue"));
		fireEvent.keyDown(document.body, { key: "a", metaKey: true });
		expect(handlers.onSelectColumn).toHaveBeenLastCalledWith("queue");
		fireEvent.keyDown(screen.getByRole("button", { name: "in backlog" }), {
			key: "A",
			ctrlKey: true,
		});
		expect(handlers.onSelectColumn).toHaveBeenLastCalledWith("backlog");
		fireEvent.pointerOver(document.body);
		fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
		expect(handlers.onSelectColumn).toHaveBeenCalledTimes(2);
	});

	it("undoes on Ctrl/Cmd+Z, not on Ctrl+Shift+Z", () => {
		const handlers = setup();
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
		expect(handlers.onUndo).toHaveBeenCalledTimes(1);
	});

	it("clears and deletes a selection, and only a selection", () => {
		const none = setup();
		fireEvent.keyDown(document.body, { key: "Escape" });
		fireEvent.keyDown(document.body, { key: "Delete" });
		expect(none.onClearSelection).not.toHaveBeenCalled();
		expect(none.onDeleteSelection).not.toHaveBeenCalled();
	});

	it("acts on Escape, Delete and Backspace with a selection", () => {
		const handlers = setup({ hasSelection: true });
		fireEvent.keyDown(document.body, { key: "Escape" });
		fireEvent.keyDown(document.body, { key: "Delete" });
		fireEvent.keyDown(document.body, { key: "Backspace" });
		fireEvent.keyDown(document.body, { key: "Delete", altKey: true });
		fireEvent.keyDown(document.body, { key: "x" });
		expect(handlers.onClearSelection).toHaveBeenCalledTimes(1);
		expect(handlers.onDeleteSelection).toHaveBeenCalledTimes(2);
	});

	it("stays quiet while typing, in a dialog, or once handled", () => {
		const handlers = setup({ hasSelection: true });
		fireEvent.keyDown(screen.getByRole("textbox", { name: "search" }), { key: "Delete" });
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		document.body.append(dialog);
		fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
		dialog.remove();
		const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		handled.preventDefault();
		window.dispatchEvent(handled);
		expect(handlers.onDeleteSelection).not.toHaveBeenCalled();
		expect(handlers.onUndo).not.toHaveBeenCalled();
		expect(handlers.onClearSelection).not.toHaveBeenCalled();
	});
});
