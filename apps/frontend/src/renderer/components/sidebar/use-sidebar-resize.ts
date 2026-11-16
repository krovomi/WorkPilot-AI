import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	clampSidebarWidth,
	type DragOutcome,
	dragOutcome,
	keyAction,
	maxWidthFor,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_RAIL_WIDTH,
} from "./sidebar-width";

export interface SidebarLayoutPatch {
	sidebarWidth?: number;
	sidebarCollapsed?: boolean;
}

interface Options {
	/** The saved width (settings.sidebarWidth), possibly missing. */
	readonly storedWidth: number | undefined;
	/** The saved fold state (settings.sidebarCollapsed). */
	readonly isCollapsed: boolean;
	/** Saves a change; the fold state shown waits for it to settle. */
	readonly onCommit: (patch: SidebarLayoutPatch) => Promise<unknown> | unknown;
}

function viewportWidth(): number {
	return window.innerWidth;
}

/**
 * The menu's width and fold state while its edge is dragged or moved with the
 * keyboard. The settings store stays the source of truth: a drag only shows a
 * preview, saved once on release (Escape cancels it).
 */
export function useSidebarResize({ storedWidth, isCollapsed, onCommit }: Options) {
	const [viewport, setViewport] = useState(viewportWidth);
	const [width, setWidth] = useState(() => clampSidebarWidth(storedWidth, viewport));
	const [preview, setPreview] = useState<DragOutcome | null>(null);
	const [isResizing, setIsResizing] = useState(false);
	// The fold state just asked for, shown until the save settles (no flicker).
	const [foldedOverride, setFoldedOverride] = useState<boolean | null>(null);
	const previewRef = useRef<DragOutcome | null>(null);
	const pendingKeyWidth = useRef<number | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);

	const folded = foldedOverride ?? isCollapsed;

	useEffect(() => {
		const onResize = () => setViewport(viewportWidth());
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// A width saved elsewhere (another window, settings reset) is followed.
	useEffect(() => {
		setWidth(clampSidebarWidth(storedWidth));
	}, [storedWidth]);

	// A drag in progress when the menu unmounts must not leave listeners behind.
	useEffect(() => () => cleanupRef.current?.(), []);

	const commit = useCallback(
		(patch: SidebarLayoutPatch) => {
			if (patch.sidebarCollapsed !== undefined) setFoldedOverride(patch.sidebarCollapsed);
			void Promise.resolve(onCommit(patch)).finally(() => setFoldedOverride(null));
		},
		[onCommit],
	);

	const shownWidth = clampSidebarWidth(width, viewport);

	const endDrag = useCallback(
		(apply: boolean) => {
			const outcome = previewRef.current;
			cleanupRef.current?.();
			cleanupRef.current = null;
			previewRef.current = null;
			setPreview(null);
			setIsResizing(false);
			if (!apply || !outcome) return;
			if (outcome.folded) {
				if (!folded) commit({ sidebarCollapsed: true });
				return;
			}
			setWidth(outcome.width);
			const patch: SidebarLayoutPatch = {};
			if (outcome.width !== clampSidebarWidth(storedWidth)) patch.sidebarWidth = outcome.width;
			if (folded) patch.sidebarCollapsed = false;
			if (Object.keys(patch).length > 0) commit(patch);
		},
		[commit, folded, storedWidth],
	);

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const target = e.currentTarget;
			target.focus();
			// Moves over a terminal or a web view still reach the handle.
			target.setPointerCapture?.(e.pointerId);
			const startX = e.clientX;
			const startWidth = folded ? SIDEBAR_RAIL_WIDTH : shownWidth;
			setIsResizing(true);

			const onMove = (ev: PointerEvent) => {
				const next = dragOutcome(
					startWidth,
					ev.clientX - startX,
					viewportWidth(),
					SIDEBAR_RAIL_WIDTH,
				);
				previewRef.current = next;
				setPreview(next);
			};
			const onUp = () => endDrag(true);
			const onKey = (ev: KeyboardEvent) => {
				if (ev.key === "Escape") {
					ev.preventDefault();
					endDrag(false);
				}
			};
			const body = document.body.style;
			const previousCursor = body.cursor;
			const previousSelect = body.userSelect;
			body.cursor = "col-resize";
			body.userSelect = "none";
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onUp);
			window.addEventListener("keydown", onKey);
			cleanupRef.current = () => {
				body.cursor = previousCursor;
				body.userSelect = previousSelect;
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onUp);
				window.removeEventListener("keydown", onKey);
			};
		},
		[endDrag, folded, shownWidth],
	);

	const onDoubleClick = useCallback(() => {
		setWidth(SIDEBAR_DEFAULT_WIDTH);
		const patch: SidebarLayoutPatch = { sidebarWidth: SIDEBAR_DEFAULT_WIDTH };
		if (folded) patch.sidebarCollapsed = false;
		commit(patch);
	}, [commit, folded]);

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLElement>) => {
			const action = keyAction(e.key, e.shiftKey, shownWidth, folded, viewport);
			if (action.kind === "none") return;
			e.preventDefault();
			if (action.kind === "toggle") {
				commit({ sidebarCollapsed: !folded });
			} else {
				setWidth(action.width);
				pendingKeyWidth.current = action.width;
			}
		},
		[commit, folded, shownWidth, viewport],
	);

	// A held arrow repeats keydown: the width is saved once, on release.
	const onKeyUp = useCallback(() => {
		const pending = pendingKeyWidth.current;
		pendingKeyWidth.current = null;
		if (pending !== null && pending !== clampSidebarWidth(storedWidth)) {
			commit({ sidebarWidth: pending });
		}
	}, [commit, storedWidth]);

	const previewFolded = preview ? preview.folded : folded;
	const previewWidth = preview ? preview.width : shownWidth;

	return {
		/** Width of the whole menu as shown now (the rail's alone when folded). */
		width: previewFolded ? SIDEBAR_RAIL_WIDTH : previewWidth,
		/** Width of the unfolded menu, for the handle's value. */
		panelWidth: previewWidth,
		folded: previewFolded,
		/** True from press to release; the drag sheet waits for a real move. */
		isResizing,
		isDragging: preview !== null,
		maxWidth: maxWidthFor(viewport),
		handlers: { onPointerDown, onDoubleClick, onKeyDown, onKeyUp },
	};
}
