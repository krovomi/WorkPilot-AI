/**
 * "Generate team report" in "How you compare": the comparison as a PDF to
 * hand on, for a project of this computer or of a server alike.
 *
 * The renderer words the comparison in the app's language; it is not trusted
 * (S6). The document is read again as strings only, capped, and printed by
 * the app's one printable-report writer (`compliance/report-export.ts`):
 * every string escaped, a page that allows no script and no remote resource,
 * printed in a hidden window with JavaScript off. The file goes where the
 * person chose in a save dialog, never to a path the renderer names.
 */

import type { IPCResult } from "../shared/types";
import { getAppLanguage } from "./app-language";
import { readDocument, writeExport } from "./compliance/report-export";
import { showSaveDialog } from "./electron-utils";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The worded comparison, or null when it has no title or no table. */
export function readReport(raw: unknown): ReturnType<typeof readDocument> | null {
	if (!isRecord(raw) || typeof raw.title !== "string" || !raw.title.trim()) return null;
	const document = readDocument(raw);
	return document.tables.length > 0 ? document : null;
}

/** Ask where to save the report and print it there; null data when cancelled. */
export async function exportComparisonReport(raw: unknown): Promise<IPCResult<string | null>> {
	const document = readReport(raw);
	if (!document) return { success: false, error: "Nothing to export" };
	const day = new Date().toISOString().slice(0, 10);
	const { canceled, filePath } = await showSaveDialog({
		defaultPath: `how-you-compare-${day}.pdf`,
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	});
	if (canceled || !filePath) return { success: true, data: null };
	try {
		await writeExport("pdf", { report: null, document, language: getAppLanguage() }, filePath);
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { success: true, data: filePath };
}
