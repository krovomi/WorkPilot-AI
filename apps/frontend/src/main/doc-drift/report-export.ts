/**
 * The drift report as a file to hand on: JSON (the data) or HTML (the page) (#354).
 *
 * Both come from the renderer, which is not trusted (S6). JSON keeps only the
 * report's known fields, typed and capped. HTML is written from the rows the
 * renderer translated: every string is escaped, and the page carries a
 * Content-Security-Policy that allows no script, no remote resource and no
 * form, so a file name read from the repository can never run in a browser.
 */
import { writeFile } from "node:fs/promises";
import type { DocDriftExportFormat } from "../../shared/types/doc-drift";

const MAX_ROWS = 5000;
const MAX_TEXT = 600;

function s(value: unknown, max = MAX_TEXT): string {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") return "";
	return Array.from(value)
		.filter((c) => {
			const code = c.codePointAt(0) ?? 0;
			return code === 9 || code === 10 || (code >= 32 && code !== 127);
		})
		.join("")
		.slice(0, max);
}

function n(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown, max = MAX_ROWS): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.slice(0, max).map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {}))
		: [];
}

export function readFormat(value: unknown): DocDriftExportFormat | null {
	return value === "json" || value === "html" ? value : null;
}

/** The report's machine fields, nothing else. */
export function toJson(raw: unknown): string {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const data = {
		docsScanned: n(r.docsScanned) ?? 0,
		codeFilesIndexed: n(r.codeFilesIndexed) ?? 0,
		averageFreshness: n(r.averageFreshness),
		issues: list(r.issues).map((i) => ({
			driftType: s(i.driftType, 40),
			severity: s(i.severity, 10),
			file: s(i.docFile, 400),
			line: n(i.docLine) ?? 0,
			symbol: s(i.referencedSymbol, 400),
			message: s(i.message),
		})),
		freshness: list(r.freshness).map((f) => ({
			file: s(f.docFile, 400),
			score: n(f.score) ?? 0,
			locale: s(f.locale, 12),
			lastUpdated: n(f.lastUpdated),
			staleSince: n(f.staleSince),
		})),
	};
	return `${JSON.stringify(data, null, 2)}\n`;
}

function esc(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** The page the renderer worded: a title, a summary line, then tables of strings. */
export function toHtml(raw: unknown): string {
	const d = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const title = s(d.title, 200) || "Documentation drift";
	const tables = list(d.tables, 10).map((table) => {
		const head = (Array.isArray(table.columns) ? table.columns : []).slice(0, 8).map((c) => s(c, 80));
		const rows = (Array.isArray(table.rows) ? table.rows : [])
			.slice(0, MAX_ROWS)
			.map((row) => (Array.isArray(row) ? row.slice(0, head.length).map((c) => s(c)) : []));
		return `<h2>${esc(s(table.title, 200))}</h2>
<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n")}</tbody></table>`;
	});
	return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'">
<title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1f2328}table{border-collapse:collapse;width:100%;margin-bottom:2rem}th,td{border:1px solid #d0d7de;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#f6f8fa}td{word-break:break-word}</style>
</head><body>
<h1>${esc(title)}</h1>
<p>${esc(s(d.summary))}</p>
${tables.join("\n")}
</body></html>
`;
}

export async function writeExport(
	format: DocDriftExportFormat,
	request: { report?: unknown; document?: unknown },
	filePath: string,
): Promise<void> {
	await writeFile(filePath, format === "json" ? toJson(request.report) : toHtml(request.document), "utf-8");
}
