/**
 * An element pointed in the task preview (F10), as the renderer sees it:
 * a summary to show on its chip. What the main process read about it stays
 * in the main process (`main/ipc-handlers/task/preview-point-handlers.ts`).
 */
export interface PointedElementSummary {
	/** The id the main process keeps the element under. */
	id: string;
	/** `button#buy.cta`. */
	selector: string;
	/** The element's visible text, shortened. */
	text: string;
	/** The files that probably render it, the most telling first. */
	candidates: Array<{ path: string; line: number }>;
	/** `data:image/png;…` of the element's box, null when the page gave none. */
	image: string | null;
}

/** One pointed element and what the person wants changed about it. */
export interface PointedSendItem {
	elementId: string;
	text: string;
}
