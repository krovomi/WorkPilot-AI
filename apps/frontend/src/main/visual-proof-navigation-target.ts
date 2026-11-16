import { logger } from "./app-logger";

/**
 * Where a web navigation step may take the hidden capture window.
 *
 * A step names a route of the application being proven (`/invoices/new`) or
 * an absolute address on that same application. The capture window only ever
 * shows that application: a step whose address leads to another origin
 * (another host or port, `file:`, `data:`…) is skipped, and the screenshot is
 * taken of the page the plan had already reached.
 */
export function navigationTargetOnOrigin(stepPath: string, baseUrl: string): string | null {
	let target: URL;
	try {
		target = new URL(stepPath, baseUrl);
	} catch {
		logger.warn(`[VisualProof] Navigation step ignored, not an address: ${stepPath}`);
		return null;
	}
	if (target.origin !== new URL(baseUrl).origin) {
		logger.warn(`[VisualProof] Navigation step ignored, outside the application: ${stepPath}`);
		return null;
	}
	return target.toString();
}
