import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcutsHelpStore } from "../../stores/shortcuts-help-store";
import { BoardKeyboard } from "./BoardKeyboard";

const isMac = vi.hoisted(() => ({ value: false }));
vi.mock("../../lib/os-detection", () => ({ isMacOS: () => isMac.value }));

function renderBoard(announce = vi.fn()) {
	render(
		<>
			<div data-column-status="queue">
				<div data-task-id="a">
					<div role="option" aria-selected={false} className="kanban-card" tabIndex={0} aria-label="First" />
				</div>
				<div data-task-id="b">
					<div role="option" aria-selected={false} className="kanban-card" tabIndex={0} aria-label="Second" />
				</div>
			</div>
			<BoardKeyboard
				onSelectColumn={vi.fn()}
				hasSelection={false}
				onClearSelection={vi.fn()}
				onDeleteSelection={vi.fn()}
				onUndo={vi.fn()}
				announce={announce}
			/>
		</>,
	);
	return announce;
}

beforeEach(() => {
	isMac.value = false;
	useShortcutsHelpStore.setState({ open: false });
});
afterEach(() => useShortcutsHelpStore.setState({ open: false }));

describe("BoardKeyboard", () => {
	it("says where an arrow key put the focus", () => {
		const announce = renderBoard();
		fireEvent.keyDown(screen.getByRole("option", { name: "First" }), { key: "ArrowDown" });
		expect(announce).toHaveBeenCalledWith("2 of 2, Queue");
	});

	it("lists the board's keys on Ctrl+/, with Ctrl and translated key names", async () => {
		renderBoard();
		fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
		const help = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
		const undo = within(help).getByText("Undo the last change").parentElement as HTMLElement;
		expect(within(undo).getByText("Ctrl")).toBeInTheDocument();
		expect(within(undo).getByText("Z")).toBeInTheDocument();
		expect(within(help).getAllByText("Shift")).toHaveLength(2);
		await userEvent.keyboard("{Escape}");
		expect(useShortcutsHelpStore.getState().open).toBe(false);
	});

	it("shows ⌘ on macOS", () => {
		isMac.value = true;
		renderBoard();
		act(() => useShortcutsHelpStore.getState().setOpen(true));
		expect(screen.getAllByText("⌘").length).toBeGreaterThan(0);
		expect(screen.queryByText("Ctrl")).toBeNull();
	});
});
