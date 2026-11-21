import { useEffect, useRef } from "react";
import { ARROW_DIRECTIONS, type CardFocus, moveCardFocus } from "../lib/card-focus";
import { isTypingTarget, keyboardIsOwned } from "./useQuickAddShortcut";

interface BoardShortcuts {
	/** Ctrl/Cmd+A: every card of the column under the pointer or the focus. */
	onSelectColumn: (status: string) => void;
	hasSelection: boolean;
	/** Escape, with a selection. */
	onClearSelection: () => void;
	/** Delete or Backspace, with a selection. */
	onDeleteSelection: () => void;
	/** Ctrl/Cmd+Z. */
	onUndo: () => void;
	/** Ctrl/Cmd+/ or ?: the list of the board's keys. */
	onShowShortcuts: () => void;
	/** An arrow key moved the focus to another card. */
	onCardFocus: (focus: CardFocus) => void;
}

const COLUMN = "[data-column-status]";

/**
 * The board's keys: arrows between cards, selection, undo, help. Never while typing, nor while a
 * dialog or a menu owns the keyboard; Ctrl and Cmd both count, so the keys
 * read the same on every platform.
 */
export function useBoardShortcuts(shortcuts: BoardShortcuts): void {
	const latest = useRef(shortcuts);
	latest.current = shortcuts;
	const pointerColumn = useRef<string | null>(null);

	useEffect(() => {
		const onPointerOver = (e: PointerEvent) => {
			const column = (e.target as Element | null)?.closest?.(COLUMN);
			pointerColumn.current = column?.getAttribute("data-column-status") ?? null;
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented || isTypingTarget(e.target) || keyboardIsOwned()) {
				return;
			}
			const current = latest.current;
			const command = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
			const key = e.key.toLowerCase();
			const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
			const direction = ARROW_DIRECTIONS[e.key];
			if (direction && plain && !e.shiftKey) {
				const focus = moveCardFocus(e.target, direction);
				if (!focus) return;
				e.preventDefault();
				current.onCardFocus(focus);
			} else if ((key === "/" && (e.ctrlKey || e.metaKey)) || (key === "?" && plain)) {
				e.preventDefault();
				current.onShowShortcuts();
			} else if (command && key === "a") {
				const focused = (e.target as Element | null)?.closest?.(COLUMN);
				const status =
					focused?.getAttribute("data-column-status") ?? pointerColumn.current;
				if (!status) return;
				e.preventDefault();
				current.onSelectColumn(status);
			} else if (command && key === "z") {
				e.preventDefault();
				current.onUndo();
			} else if (!current.hasSelection || e.ctrlKey || e.metaKey || e.altKey) {
				return;
			} else if (e.key === "Escape") {
				current.onClearSelection();
			} else if (e.key === "Delete" || e.key === "Backspace") {
				e.preventDefault();
				current.onDeleteSelection();
			}
		};
		document.addEventListener("pointerover", onPointerOver);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerover", onPointerOver);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);
}
