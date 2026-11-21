/**
 * Dragging work items from an import side panel to a Kanban column.
 *
 * The board reads `{ type: "<kind>-workitems", workItems }` from the
 * `application/json` drag data on drop, and listens for `<kind>-drag-start`
 * and `<kind>-drag-end` on the document to show its drop zones.
 */
import type React from "react";

export type PanelKind = "jira" | "azure-devops";

/** Starts the drag and returns the ghost image, to remove with `endItemDrag`. */
export function startItemDrag<T>(event: React.DragEvent<HTMLElement>, kind: PanelKind, workItems: T[]): HTMLElement {
	const dragData = { type: `${kind}-workitems`, workItems };
	event.dataTransfer.setData("application/json", JSON.stringify(dragData));
	event.dataTransfer.effectAllowed = "copy";

	// The dragged row, outlined, follows the pointer.
	const source = event.currentTarget;
	const ghost = source.cloneNode(true) as HTMLElement;
	Object.assign(ghost.style, {
		position: "absolute",
		top: "-1000px",
		left: "-1000px",
		width: `${source.offsetWidth}px`,
		outline: "2px solid var(--primary)",
		outlineOffset: "2px",
		borderRadius: "8px",
		boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
		opacity: "0.95",
		backgroundColor: "var(--card)",
	});
	document.body.appendChild(ghost);
	event.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 20);

	document.dispatchEvent(new CustomEvent(`${kind}-drag-start`, { detail: dragData, bubbles: true, cancelable: true }));
	return ghost;
}

export function endItemDrag(kind: PanelKind, ghost: HTMLElement | null): void {
	ghost?.remove();
	document.dispatchEvent(new CustomEvent(`${kind}-drag-end`, { bubbles: true, cancelable: true }));
}
