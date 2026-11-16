/**
 * Width, collapse and closing of an import side panel.
 *
 * The width is saved per project when a resize ends or before the panel
 * collapses, never from an effect: an effect would write the previous
 * project's width under the new project's key when the project changes.
 * A click outside the panel (and outside any dialog it opened) closes it,
 * and nothing dragged over the panel reaches the board beneath it.
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	PANEL_DEFAULT_WIDTH,
	PANEL_MAX_WIDTH,
	PANEL_MIN_WIDTH,
	readPanelWidth,
	writePanelWidth,
} from "./panel-storage";

export interface SidePanelLayout {
	readonly panelRef: React.RefObject<HTMLElement | null>;
	readonly width: number;
	readonly collapsed: boolean;
	readonly toggleCollapse: () => void;
	readonly startResize: (event: React.MouseEvent) => void;
}

export function useSidePanelLayout(
	storageKey: string,
	open: boolean,
	onOpenChange: (open: boolean) => void,
): SidePanelLayout {
	const panelRef = useRef<HTMLElement | null>(null);
	const [width, setWidth] = useState(PANEL_DEFAULT_WIDTH);
	const stopResize = useRef<(() => void) | null>(null);

	useEffect(() => {
		setWidth(readPanelWidth(storageKey) ?? PANEL_DEFAULT_WIDTH);
	}, [storageKey]);

	useEffect(() => () => stopResize.current?.(), []);

	useEffect(() => {
		if (!open) return;
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			if (panelRef.current?.contains(target)) return;
			const element = target instanceof Element ? target : target.parentElement;
			if (element?.closest('[role="alertdialog"], [role="dialog"], [data-radix-portal]')) return;
			onOpenChange(false);
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open, onOpenChange]);

	// The board's column under the panel is hidden: a drag over the panel, or a
	// drop on it, must not reach the board's document listeners.
	useEffect(() => {
		const panel = panelRef.current;
		if (!open || !panel) return;
		const keepInPanel = (event: DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
		};
		panel.addEventListener("dragover", keepInPanel);
		panel.addEventListener("drop", keepInPanel);
		return () => {
			panel.removeEventListener("dragover", keepInPanel);
			panel.removeEventListener("drop", keepInPanel);
		};
	}, [open]);

	const collapsed = width <= PANEL_MIN_WIDTH;

	const toggleCollapse = useCallback(() => {
		if (collapsed) {
			setWidth(readPanelWidth(storageKey) ?? PANEL_DEFAULT_WIDTH);
		} else {
			writePanelWidth(storageKey, width);
			setWidth(PANEL_MIN_WIDTH);
		}
	}, [collapsed, storageKey, width]);

	const startResize = useCallback(
		(event: React.MouseEvent) => {
			const startX = event.clientX;
			let latest = width;
			const move = (e: MouseEvent) => {
				latest = Math.min(Math.max(width + startX - e.clientX, PANEL_MIN_WIDTH), PANEL_MAX_WIDTH);
				setWidth(latest);
			};
			const stop = () => {
				document.removeEventListener("mousemove", move);
				document.removeEventListener("mouseup", end);
				stopResize.current = null;
			};
			const end = () => {
				stop();
				if (latest > PANEL_MIN_WIDTH) writePanelWidth(storageKey, latest);
			};
			stopResize.current?.();
			stopResize.current = stop;
			document.addEventListener("mousemove", move);
			document.addEventListener("mouseup", end);
		},
		[storageKey, width],
	);

	return { panelRef, width, collapsed, toggleCollapse, startResize };
}
