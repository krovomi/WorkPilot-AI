import { type RefObject, useEffect } from "react";
import { useVisualToCodeStore } from "../../stores/visual-to-code-store";

interface FitViewInstance {
	fitView?: (options?: { padding?: number; maxZoom?: number; duration?: number }) => void;
}

/**
 * Frame the diagram whenever the canvas is shown or another document is opened.
 *
 * The hub keeps the canvas mounted behind the design-import tab, so ReactFlow's
 * own `fitView` runs on a pane of zero size and opens on a speck in a corner.
 * Re-framing when the tab becomes visible, or the document changes, is what
 * makes the first look at a diagram the diagram. `maxZoom` 1: a three-block
 * diagram is shown at its size, not blown up to fill the screen.
 */
export function useFitViewOnShow(
	instanceRef: RefObject<FitViewInstance | null>,
	documentId: string | null,
) {
	const visible = useVisualToCodeStore((state) => state.activeMode === "canvas");
	useEffect(() => {
		if (!visible || !documentId) return;
		const timer = setTimeout(
			() => instanceRef.current?.fitView?.({ padding: 0.15, maxZoom: 1 }),
			// After ReactFlow has measured the cards, which it cannot do while
			// the pane is hidden: framing zero-sized nodes frames the wrong box.
			250,
		);
		return () => clearTimeout(timer);
	}, [visible, documentId, instanceRef]);
}
