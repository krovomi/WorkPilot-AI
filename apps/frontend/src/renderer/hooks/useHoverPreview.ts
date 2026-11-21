import { useCallback, useEffect, useRef, useState } from "react";

/** Rest time before a card's preview opens: long enough to cross the board without one. */
export const CARD_PREVIEW_OPEN_DELAY_MS = 700;
/** Grace before it closes once the pointer has left, so a jitter does not flicker it. */
export const CARD_PREVIEW_CLOSE_DELAY_MS = 150;
/** After one preview closed, the next card shows its own at once for this long. */
export const CARD_PREVIEW_WARM_MS = 300;

let lastClosedAt = 0;

/**
 * Elements that answer the pointer themselves (buttons, links, menus, badges
 * with their own tooltip): resting on them shows their own help, not the
 * card's preview.
 */
const OWN_HOVER =
	'button, a, input, select, textarea, [role="menuitem"], [data-state], [data-no-card-preview]';

function ownsHover(target: EventTarget | null, host: Element): boolean {
	if (!(target instanceof Element)) return false;
	// A portalled menu or dialog of the card bubbles its React events here.
	if (!host.contains(target)) return true;
	const hit = target.closest(OWN_HOVER);
	return !!hit && hit !== host && host.contains(hit);
}

/**
 * Hover intent for a card preview: opens after the pointer rests
 * `CARD_PREVIEW_OPEN_DELAY_MS` on the card (or the card keeps the keyboard
 * focus as long), closes on leave, on press (a drag starts with one) and on
 * Escape. The handlers call `preventDefault()` so a Radix trigger wrapping
 * the card does not run its own timing on top.
 */
export function useHoverPreview(enabled = true) {
	const [open, setOpen] = useState(false);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pressed = useRef(false);

	const clearTimers = useCallback(() => {
		if (openTimer.current) clearTimeout(openTimer.current);
		if (closeTimer.current) clearTimeout(closeTimer.current);
		openTimer.current = null;
		closeTimer.current = null;
	}, []);

	const close = useCallback(() => {
		clearTimers();
		setOpen((was) => {
			if (was) lastClosedAt = Date.now();
			return false;
		});
	}, [clearTimers]);

	const scheduleOpen = useCallback(() => {
		if (!enabled || pressed.current) return;
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		if (openTimer.current) return;
		if (Date.now() - lastClosedAt < CARD_PREVIEW_WARM_MS) {
			setOpen(true);
			return;
		}
		openTimer.current = setTimeout(() => {
			openTimer.current = null;
			setOpen(true);
		}, CARD_PREVIEW_OPEN_DELAY_MS);
	}, [enabled]);

	useEffect(() => clearTimers, [clearTimers]);
	useEffect(() => {
		if (!enabled) close();
	}, [enabled, close]);

	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			e.preventDefault();
			if (e.pointerType === "touch") return;
			if (ownsHover(e.target, e.currentTarget)) {
				close();
				return;
			}
			if (!open) scheduleOpen();
		},
		[open, close, scheduleOpen],
	);

	const onPointerLeave = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			e.preventDefault();
			pressed.current = false;
			if (openTimer.current) {
				clearTimeout(openTimer.current);
				openTimer.current = null;
			}
			if (!closeTimer.current) {
				closeTimer.current = setTimeout(close, CARD_PREVIEW_CLOSE_DELAY_MS);
			}
		},
		[close],
	);

	const onPointerDown = useCallback(() => {
		pressed.current = true;
		close();
	}, [close]);

	const onFocus = useCallback(
		(e: React.FocusEvent<HTMLElement>) => {
			e.preventDefault();
			if (e.target !== e.currentTarget) return;
			let visible = true;
			try {
				visible = e.currentTarget.matches(":focus-visible");
			} catch {
				// An engine without :focus-visible: treat focus as keyboard focus.
			}
			if (visible) scheduleOpen();
		},
		[scheduleOpen],
	);

	const onBlur = useCallback(
		(e: React.FocusEvent<HTMLElement>) => {
			e.preventDefault();
			close();
		},
		[close],
	);

	/** Radix asks to close (Escape, outside press): honour it, never an open. */
	const onOpenChange = useCallback(
		(next: boolean) => {
			if (!next) close();
		},
		[close],
	);

	return {
		open,
		onOpenChange,
		triggerProps: { onPointerMove, onPointerLeave, onPointerDown, onFocus, onBlur },
	};
}

/** Tests only. */
export function resetHoverPreviewWarmthForTests(): void {
	lastClosedAt = 0;
}
