/**
 * The compliance report as files for an auditor: JSON (for GRC tools), CSV
 * (for a spreadsheet), HTML and PDF (to read) (#357).
 *
 * JSON is the report as the collector wrote it, kept in main: the renderer
 * never supplies it. CSV, HTML and PDF are the tables the renderer worded in
 * the app's language, read as untrusted strings (S6): every cell is escaped
 * (HTML) or quoted and defused (CSV: a cell starting with `=`, `+`, `-`, `@`
 * would run as a formula), the page allows no script and no remote resource,
 * and the PDF is printed from that same page in a hidden window with
 * JavaScript off.
 */
import { writeFile } from "node:fs/promises";
import { BrowserWindow } from "electron";
import type { ComplianceExportFormat } from "../../shared/types/compliance";

const MAX_ROWS = 5000;
const MAX_TABLES = 10;
const MAX_COLUMNS = 10;
const MAX_TEXT = 800;

interface Table {
	title: string;
	columns: string[];
	rows: string[][];
}

interface Document {
	title: string;
	summary: string[];
	tables: Table[];
}

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

function list(value: unknown, max: number): unknown[] {
	return Array.isArray(value) ? value.slice(0, max) : [];
}

export function readFormat(value: unknown): ComplianceExportFormat | null {
	return value === "json" || value === "csv" || value === "html" || value === "pdf" ? value : null;
}

/** The worded document's strings, nothing else. */
export function readDocument(raw: unknown): Document {
	const d = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		title: s(d.title, 200) || "Compliance report",
		summary: list(d.summary, 20).map((line) => s(line)),
		tables: list(d.tables, MAX_TABLES).map((item) => {
			const t = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
			const columns = list(t.columns, MAX_COLUMNS).map((c) => s(c, 80));
			return {
				title: s(t.title, 200),
				columns,
				rows: list(t.rows, MAX_ROWS).map((row) =>
					list(row, columns.length).map((cell) => s(cell)),
				),
			};
		}),
	};
}

function csvCell(value: string): string {
	const defused = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return `"${defused.replaceAll('"', '""')}"`;
}

/** Every table one after the other, a blank line and its title between them. */
export function toCsv(raw: unknown): string {
	const doc = readDocument(raw);
	const lines: string[] = [];
	for (const table of doc.tables) {
		if (lines.length) lines.push("");
		lines.push(csvCell(table.title));
		lines.push(table.columns.map(csvCell).join(","));
		for (const row of table.rows) lines.push(row.map(csvCell).join(","));
	}
	return `${lines.join("\r\n")}\r\n`;
}

function esc(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function toHtml(raw: unknown, language: string): string {
	const doc = readDocument(raw);
	const lang = /^[a-z]{2}$/.test(language) ? language : "en";
	const tables = doc.tables.map(
		(t) => `<h2>${esc(t.title)}</h2>
<table><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
<tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n")}</tbody></table>`,
	);
	return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'">
<title>${esc(doc.title)}</title>
<style>body{font:13px/1.5 system-ui,sans-serif;margin:2rem;color:#1f2328}h1{font-size:22px;margin:0 0 .5rem}
ul.summary{padding-left:1.2rem;margin:0 0 1.5rem}table{border-collapse:collapse;width:100%;margin-bottom:2rem}
th,td{border:1px solid #d0d7de;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#f6f8fa}
td{word-break:break-word}@media print{h2{break-after:avoid}tr{break-inside:avoid}}</style>
</head><body>
<h1>${esc(doc.title)}</h1>
<ul class="summary">${doc.summary.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
${tables.join("\n")}
</body></html>
`;
}

/** Writes the export to `filePath`, chosen by the person in a save dialog. */
export async function writeExport(
	format: ComplianceExportFormat,
	request: { report: unknown; document: unknown; language: string },
	filePath: string,
): Promise<void> {
	if (format === "json") {
		await writeFile(filePath, `${JSON.stringify(request.report, null, 2)}\n`, "utf-8");
		return;
	}
	if (format === "csv") {
		await writeFile(filePath, `﻿${toCsv(request.document)}`, "utf-8");
		return;
	}
	const html = toHtml(request.document, request.language);
	if (format === "html") {
		await writeFile(filePath, html, "utf-8");
		return;
	}
	const win = new BrowserWindow({
		show: false,
		webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	try {
		await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
		await writeFile(filePath, pdf);
	} finally {
		win.destroy();
	}
}
