import { useEffect } from "react";

/** Something the person is typing in: a key there is text, never a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

// An open dialog or menu owns the keyboard (the wizard, a card's panel, a
// confirmation, a dropdown).
const KEYBOARD_OWNERS =
	'[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * The board's N key: opens the quick-add box of the Planification column.
 * Plain N only, never while typing or while a dialog or menu is open, so it
 * does not collide with Ctrl+N (the full wizard) or with text.
 */
export function useQuickAddShortcut(enabled: boolean, open: () => void): void {
	useEffect(() => {
		if (!enabled) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.repeat) return;
			if (e.key !== "n" && e.key !== "N") return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (isTypingTarget(e.target)) return;
			if (document.querySelector(KEYBOARD_OWNERS)) return;
			e.preventDefault();
			open();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [enabled, open]);
}
