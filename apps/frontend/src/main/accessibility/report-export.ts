/**
 * The accessibility report as a file the person can hand on: HTML, CSV or PDF (#391).
 *
 * The report comes from the renderer, which is not trusted (S6): it is read
 * field by field here, every string is escaped (HTML) or quoted and defused
 * (CSV: a cell starting with `=`, `+`, `-` or `@` would run as a formula in a
 * spreadsheet), and the PDF is printed from that same escaped HTML in a
 * hidden window with JavaScript off.
 */
import { writeFileSync } from "node:fs";
import { BrowserWindow } from "electron";

export type ExportFormat = "html" | "csv" | "pdf";

interface Row {
	severity: string;
	ruleId: string;
	criterion: string;
	level: string;
	description: string;
	location: string;
	element: string;
	suggestion: string;
}

interface Summary {
	score: number | null;
	targetLevel: string;
	filesScanned: number;
	rows: Row[];
	criteria: { criterion: string; name: string; count: number; score: number }[];
}

const MAX_ROWS = 5000;

function s(value: unknown, max = 400): string {
	return typeof value === "string" ? value.slice(0, max) : typeof value === "number" ? String(value) : "";
}

function n(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The fields of the report this export prints; anything else is dropped. */
export function readReport(raw: unknown): Summary {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const violations = Array.isArray(r.violations) ? r.violations.slice(0, MAX_ROWS) : [];
	const criteria = Array.isArray(r.criteria) ? r.criteria.slice(0, 100) : [];
	return {
		score: typeof r.score === "number" && Number.isFinite(r.score) ? Math.round(r.score) : null,
		targetLevel: s(r.targetLevel, 4),
		filesScanned: n(r.filesScanned),
		rows: violations.map((item) => {
			const v = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
			const line = n(v.line);
			return {
				severity: s(v.severity, 20),
				ruleId: s(v.ruleId, 60),
				criterion: s(v.wcagCriteria, 10),
				level: s(v.wcagLevel, 4),
				description: s(v.description),
				location: line > 0 ? `${s(v.file, 300)}:${line}` : s(v.file, 300),
				element: s(v.element, 160),
				suggestion: s(v.suggestion),
			};
		}),
		criteria: criteria.map((item) => {
			const c = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
			return { criterion: s(c.criterion, 10), name: s(c.name, 80), count: n(c.count), score: n(c.score) };
		}),
	};
}

const COLUMNS: (keyof Row)[] = [
	"severity", "ruleId", "criterion", "level", "description", "location", "element", "suggestion",
];

function csvCell(value: string): string {
	const defused = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return `"${defused.replace(/"/g, '""')}"`;
}

export function renderCsv(raw: unknown): string {
	const report = readReport(raw);
	const lines = [COLUMNS.join(",")];
	for (const row of report.rows) lines.push(COLUMNS.map((c) => csvCell(row[c])).join(","));
	return `${lines.join("\r\n")}\r\n`;
}

function esc(value: string | number): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function renderHtml(raw: unknown, title: string, generatedAt: string): string {
	const report = readReport(raw);
	const criteria = report.criteria
		.map((c) => `<tr><td>${esc(c.criterion)}</td><td>${esc(c.name)}</td><td>${esc(c.count)}</td><td>${esc(c.score)}</td></tr>`)
		.join("");
	const rows = report.rows
		.map(
			(r) =>
				`<tr class="${esc(r.severity)}"><td>${esc(r.severity)}</td><td>${esc(r.ruleId)}<br><small>WCAG ${esc(r.criterion)} (${esc(r.level)})</small></td>` +
				`<td>${esc(r.description)}<br><small>${esc(r.suggestion)}</small></td><td><code>${esc(r.location)}</code><br><code>${esc(r.element)}</code></td></tr>`,
		)
		.join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:32px;color:#1a1a1a}
h1{font-size:22px;margin:0 0 4px}p.meta{color:#555;margin:0 0 20px}
.score{font-size:40px;font-weight:700}table{border-collapse:collapse;width:100%;margin:12px 0 28px}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f2f2}
tr.critical td:first-child{color:#a40000;font-weight:700}tr.serious td:first-child{color:#8a4b00;font-weight:700}
code{font-size:12px;word-break:break-all}small{color:#555}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">WCAG 2.2 ${esc(report.targetLevel)} · ${esc(report.filesScanned)} files · ${esc(generatedAt)}</p>
${report.score === null ? "" : `<p><span class="score">${esc(report.score)}</span> / 100</p>`}
<h2>Criteria</h2><table><thead><tr><th>Criterion</th><th>Name</th><th>Violations</th><th>Score</th></tr></thead><tbody>${criteria}</tbody></table>
<h2>Violations (${esc(report.rows.length)})</h2>
<table><thead><tr><th>Severity</th><th>Rule</th><th>Issue</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

/** Writes the export to `filePath` (chosen by the person in a save dialog). */
export async function writeExport(
	format: ExportFormat,
	raw: unknown,
	filePath: string,
	title: string,
): Promise<void> {
	const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
	if (format === "csv") {
		writeFileSync(filePath, `﻿${renderCsv(raw)}`, "utf-8");
		return;
	}
	const html = renderHtml(raw, title, generatedAt);
	if (format === "html") {
		writeFileSync(filePath, html, "utf-8");
		return;
	}
	const win = new BrowserWindow({
		show: false,
		webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	try {
		await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
		writeFileSync(filePath, pdf);
	} finally {
		win.destroy();
	}
}
