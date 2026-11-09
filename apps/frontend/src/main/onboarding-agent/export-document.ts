/**
 * The onboarding tour exported as Markdown or as a static web page (#349).
 *
 * The renderer writes the document in the reader's language (it holds the
 * translations) and sends it as plain strings: a title and sections of lines.
 * Main takes nothing else from it (S6): the request is revalidated and capped
 * here, every string is escaped for the format, and the HTML page carries a
 * Content-Security-Policy that allows no script, no remote resource and no
 * form, so a file name or a commit subject read from the repository can never
 * run in the reader's browser.
 */
import type {
	OnboardingExportDocument,
	OnboardingExportFormat,
	OnboardingExportRequest,
} from "../../shared/types/onboarding-export";

const MAX_TEXT = 2_000;
const MAX_LINES = 400;
const MAX_SECTIONS = 60;
const MAX_TOTAL = 2_000_000;

function plain(value: unknown, max = MAX_TEXT): string | null {
	if (typeof value !== "string") return null;
	// Control characters other than tab are never prose.
	return Array.from(value.replace(/\r\n?/g, "\n"))
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code === 9 || code === 10 || (code >= 32 && code !== 127);
		})
		.join("")
		.slice(0, max);
}

/** The request as the renderer sent it, kept only where it is well formed. */
export function readExportRequest(raw: unknown): OnboardingExportRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const format = r.format;
	if (format !== "markdown" && format !== "html") return null;
	const doc = r.document as Record<string, unknown> | undefined;
	if (!doc || typeof doc !== "object") return null;
	const title = plain(doc.title, 200);
	const lang = typeof doc.lang === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(doc.lang) ? doc.lang : "en";
	if (!title || !Array.isArray(doc.sections)) return null;
	let total = title.length;
	const sections: OnboardingExportDocument["sections"] = [];
	for (const entry of doc.sections.slice(0, MAX_SECTIONS)) {
		if (!entry || typeof entry !== "object") return null;
		const section = entry as Record<string, unknown>;
		const heading = plain(section.heading, 200);
		if (heading === null || !Array.isArray(section.lines)) return null;
		const lines: string[] = [];
		for (const line of section.lines.slice(0, MAX_LINES)) {
			const text = plain(line);
			if (text === null) return null;
			lines.push(text);
			total += text.length;
		}
		const intro = section.intro === undefined ? "" : plain(section.intro, MAX_TEXT * 2);
		if (intro === null) return null;
		total += heading.length + intro.length;
		sections.push({ heading, intro, lines });
	}
	if (total > MAX_TOTAL) return null;
	const generatedAt = plain(doc.generatedAt, 80) ?? "";
	return { format, document: { title, lang, generatedAt, sections } };
}

/** A safe file name for the save dialog, from the project's name. */
export function exportFileName(title: string, format: OnboardingExportFormat): string {
	const base =
		title
			.normalize("NFKD")
			.replace(/[^\w.-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 80) || "onboarding";
	return `${base}-onboarding.${format === "html" ? "html" : "md"}`;
}

function markdownText(value: string): string {
	// Inline HTML and link syntax are written as text; code spans stay code spans.
	return value.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/\[([^\]]*)\]\(/g, "\\[$1\\](");
}

export function toMarkdown(doc: OnboardingExportDocument): string {
	const out = [`# ${markdownText(doc.title)}`, ""];
	if (doc.generatedAt) out.push(`_${markdownText(doc.generatedAt)}_`, "");
	for (const section of doc.sections) {
		out.push(`## ${markdownText(section.heading)}`, "");
		if (section.intro) out.push(markdownText(section.intro), "");
		for (const line of section.lines) out.push(`- ${markdownText(line).replace(/\n/g, " ")}`);
		out.push("");
	}
	return `${out.join("\n").trimEnd()}\n`;
}

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** `code` spans of a line as <code>, everything else as text. */
function htmlLine(value: string): string {
	return value
		.split(/(`[^`\n]+`)/g)
		.map((part) =>
			part.startsWith("`") && part.endsWith("`") && part.length > 2
				? `<code>${escapeHtml(part.slice(1, -1))}</code>`
				: escapeHtml(part),
		)
		.join("");
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'";

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1d1f;--muted:#5f6368;--line:#e3e3e0;--accent:#4f46e5;--code:#f1f1ef}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--muted:#a0a0a8;--line:#2a2a2f;--accent:#8b8cf7;--code:#1f1f24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 16px 80px}h1{font-size:2rem;margin:0 0 4px}
.meta{color:var(--muted);margin:0 0 32px}section{border-top:1px solid var(--line);padding:24px 0}
h2{font-size:1.2rem;margin:0 0 12px;color:var(--accent)}p{margin:0 0 12px}ul{margin:0;padding-left:20px}li{margin:4px 0}
code{background:var(--code);border-radius:4px;padding:1px 5px;font:0.9em ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
`;

export function toHtml(doc: OnboardingExportDocument): string {
	const sections = doc.sections
		.map((section) => {
			const intro = section.intro ? `<p>${htmlLine(section.intro)}</p>` : "";
			const items = section.lines.length
				? `<ul>${section.lines.map((line) => `<li>${htmlLine(line)}</li>`).join("")}</ul>`
				: "";
			return `<section><h2>${escapeHtml(section.heading)}</h2>${intro}${items}</section>`;
		})
		.join("\n");
	return [
		"<!doctype html>",
		`<html lang="${escapeHtml(doc.lang)}">`,
		"<head>",
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(doc.title)}</title>`,
		`<style>${STYLE}</style>`,
		"</head>",
		"<body><main>",
		`<h1>${escapeHtml(doc.title)}</h1>`,
		doc.generatedAt ? `<p class="meta">${escapeHtml(doc.generatedAt)}</p>` : "",
		sections,
		"</main></body>",
		"</html>",
		"",
	].join("\n");
}
