/**
 * From an element pointed in the task preview to the files that probably
 * render it, without depending on the framework (F10).
 *
 * The element is described by the main process over the DevTools protocol
 * (`main/preview-point.ts`): its tag, attributes, DOM path, outer HTML and a
 * few computed styles. Its markers (a test id, an id, an accessible label,
 * its visible text, a rare class) are looked for in the worktree's template
 * files, whatever the stack: JSX/TSX, Angular templates and inline
 * components, Vue and Svelte single-file components, Blazor `.razor`, Razor
 * Pages `.cshtml`, Twig, Blade, ERB, Jinja, Go templates, Leptos/Yew…
 *
 * Everything here comes from the page, so it is data, never an instruction:
 * the composed context is quoted as untrusted content when the prompt is
 * assembled (`foundation/steering.py`), never put in the person's text.
 */

/** What the main process read about the pointed element. */
export interface PointedNode {
	tag: string;
	attributes: Record<string, string>;
	/** Ancestors from the closest, e.g. `["section.hero", "main", "body"]`. */
	path: string[];
	outerHtml: string;
	styles: Record<string, string>;
	/** The page's address when the element was pointed. */
	url: string;
}

export type MarkerKind = "testid" | "id" | "aria" | "text" | "placeholder" | "name" | "class";

export interface Marker {
	kind: MarkerKind;
	value: string;
	weight: number;
}

export interface SourceCandidate {
	path: string;
	/** 1-based line of the strongest marker found in the file. */
	line: number;
	markers: MarkerKind[];
	score: number;
}

export interface SourceFile {
	path: string;
	text: string;
}

/** The files a component or a page template can live in, per stack. */
export const TEMPLATE_EXTENSIONS: readonly string[] = [
	".tsx",
	".jsx",
	".ts",
	".js",
	".mjs",
	".vue",
	".svelte",
	".astro",
	".html",
	".htm",
	".razor",
	".cshtml",
	".vbhtml",
	".twig",
	".php",
	".erb",
	".haml",
	".slim",
	".hbs",
	".handlebars",
	".ejs",
	".njk",
	".liquid",
	".jinja",
	".j2",
	".jsp",
	".ftl",
	".gohtml",
	".tmpl",
	".templ",
	".heex",
	".eex",
	".rs",
	".mdx",
];

const IGNORED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	".angular",
	"coverage",
	"vendor",
	"bin",
	"obj",
	"target",
	"wwwroot",
	".git",
]);

/** The DOM path and test ids say little about a test file: it is never the source. */
const TEST_FILE = /(^|[./_-])(test|tests|spec|specs|stories|story|e2e|cy)\.[a-z]+$/i;

export const MAX_SOURCE_FILES = 3000;
export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_CANDIDATES = 5;
const MAX_OUTER_HTML = 1500;
const TEXT_MIN = 3;
const TEXT_MAX = 80;
/** A marker found in more files than this tells nothing about where the element is. */
const MAX_FILES_PER_MARKER = 12;

/** The computed styles worth a line: what a review remark is usually about. */
export const STYLE_PROPERTIES: readonly string[] = [
	"display",
	"position",
	"width",
	"height",
	"margin",
	"padding",
	"color",
	"background-color",
	"font-family",
	"font-size",
	"font-weight",
	"line-height",
	"text-align",
	"border",
	"border-radius",
	"gap",
	"justify-content",
	"align-items",
	"opacity",
	"z-index",
];

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * The styles worth a line, from Chromium's computed list. It only gives
 * longhands (`margin-top`, `border-top-width`…): the shorthands a remark uses
 * are put back together, shortened when the sides agree.
 */
export function pickStyles(computed: Readonly<Record<string, string>>): Record<string, string> {
	const all: Record<string, string> = { ...computed };
	for (const box of ["margin", "padding"]) {
		const sides = SIDES.map((side) => all[`${box}-${side}`]);
		if (sides.every(Boolean)) {
			all[box] = sides.every((v) => v === sides[0]) ? sides[0] : sides.join(" ");
		}
	}
	const border = ["width", "style", "color"].map((part) => all[`border-top-${part}`]);
	if (border.every(Boolean) && border[1] !== "none") all.border = border.join(" ");
	if (all["border-top-left-radius"]) all["border-radius"] = all["border-top-left-radius"];
	if (all["row-gap"] && all["row-gap"] !== "normal") all.gap = all["row-gap"];
	const out: Record<string, string> = {};
	for (const name of STYLE_PROPERTIES) {
		if (all[name]) out[name] = all[name].slice(0, 120);
	}
	return out;
}

export function isTemplateFile(relPath: string): boolean {
	const normalized = relPath.replaceAll("\\", "/");
	const parts = normalized.split("/");
	if (parts.slice(0, -1).some((part) => IGNORED_DIRS.has(part))) return false;
	const name = parts.at(-1) ?? "";
	if (TEST_FILE.test(name) || name.endsWith(".d.ts") || name.endsWith(".min.js")) return false;
	const lower = name.toLowerCase();
	return TEMPLATE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The visible text of an outer HTML fragment, whitespace collapsed. */
export function textOf(outerHtml: string): string {
	return outerHtml
		.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * A utility class (Tailwind, Bootstrap, UnoCSS) or a generated one (CSS
 * modules, styled-components, Angular's `_ngcontent`): found everywhere or
 * nowhere in the sources, so never a marker.
 */
function isUtilityClass(name: string): boolean {
	if (name.length < 4 || /[:[\]/!]/.test(name)) return true;
	if (/^(ng|_ng|css|sc|jsx|svelte|emotion|chakra|mui|Mui|v)-/.test(name)) return true;
	// CSS modules write `Button_root__3xYz2`; the source only says `styles.root`.
	if (/__[A-Za-z0-9_-]{4,}$/.test(name)) return true;
	if (/^-?[a-z]+(-[a-z]+)*-(\d+(\.\d+)?|xs|sm|md|lg|xl|\dxl|auto|full|screen|px)$/.test(name))
		return true;
	return /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|container|row|col|btn|card|active|disabled|show|fade|open|selected|clearfix|truncate|uppercase|lowercase|capitalize|italic|underline|shadow|rounded|border|transition|transform|visible|invisible|items-center|justify-between|text-center|sr-only)$/.test(
		name,
	);
}

function clip(value: string): string {
	return value.trim().slice(0, TEXT_MAX);
}

/** The node's markers, strongest first. */
export function markersOf(node: PointedNode): Marker[] {
	const markers: Marker[] = [];
	const attr = node.attributes;
	for (const key of ["data-testid", "data-test", "data-cy", "data-qa", "data-test-id"]) {
		if (attr[key]?.trim()) markers.push({ kind: "testid", value: clip(attr[key]), weight: 10 });
	}
	if (attr.id?.trim() && !/^[:\d]|\d{3,}/.test(attr.id)) {
		markers.push({ kind: "id", value: clip(attr.id), weight: 8 });
	}
	if (attr["aria-label"]?.trim()) {
		markers.push({ kind: "aria", value: clip(attr["aria-label"]), weight: 6 });
	}
	const text = textOf(node.outerHtml);
	if (text.length >= TEXT_MIN && text.length <= TEXT_MAX) {
		markers.push({ kind: "text", value: text, weight: 5 });
	} else if (text.length > TEXT_MAX) {
		// A long paragraph: its first words are as telling and rarely split by markup.
		const head = text.slice(0, 40).replace(/\s+\S*$/, "");
		if (head.length >= TEXT_MIN) markers.push({ kind: "text", value: head, weight: 4 });
	}
	if (attr.placeholder?.trim()) {
		markers.push({ kind: "placeholder", value: clip(attr.placeholder), weight: 4 });
	}
	if (attr.name?.trim()) markers.push({ kind: "name", value: clip(attr.name), weight: 3 });
	for (const name of (attr.class ?? "").split(/\s+/).filter(Boolean)) {
		if (!isUtilityClass(name)) markers.push({ kind: "class", value: name, weight: 2 });
	}
	return markers.slice(0, 12);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternFor(marker: Marker): RegExp {
	const value = escapeRegExp(marker.value);
	switch (marker.kind) {
		case "text":
			// Template text may wrap: any run of whitespace matches one space.
			return new RegExp(value.replace(/ /g, "\\s+"));
		case "class":
			return new RegExp(`(^|[\\s"'\`.{])${value}($|[\\s"'\`}])`);
		default:
			// An attribute value is written between quotes in every template language.
			return new RegExp(`["'\`]${value}["'\`]`);
	}
}

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

/** The files that probably render the node, the most telling first. */
export function rankCandidates(
	files: readonly SourceFile[],
	markers: readonly Marker[],
): SourceCandidate[] {
	const hits = new Map<string, { score: number; line: number; best: number; kinds: MarkerKind[] }>();
	for (const marker of markers) {
		const pattern = patternFor(marker);
		const found: Array<{ path: string; index: number }> = [];
		for (const file of files) {
			const match = pattern.exec(file.text);
			if (match) found.push({ path: file.path, index: match.index });
		}
		if (found.length === 0 || found.length > MAX_FILES_PER_MARKER) continue;
		// Rarer is stronger: a marker in one file says more than one in ten.
		const score = marker.weight / found.length;
		for (const { path, index } of found) {
			const hit = hits.get(path) ?? { score: 0, line: 0, best: -1, kinds: [] };
			hit.score += score;
			if (!hit.kinds.includes(marker.kind)) hit.kinds.push(marker.kind);
			if (score > hit.best) {
				hit.best = score;
				const text = files.find((f) => f.path === path)?.text ?? "";
				hit.line = lineOf(text, index);
			}
			hits.set(path, hit);
		}
	}
	return [...hits.entries()]
		.map(([path, hit]) => ({
			path,
			line: hit.line,
			markers: hit.kinds,
			score: Math.round(hit.score * 100) / 100,
		}))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, MAX_CANDIDATES);
}

/** `button#buy.cta` for one element of the DOM path. */
export function selectorOf(tag: string, attributes: Record<string, string>): string {
	const id = attributes.id ? `#${attributes.id}` : "";
	const classes = (attributes.class ?? "")
		.split(/\s+/)
		.filter((c) => c && !isUtilityClass(c))
		.slice(0, 2)
		.map((c) => `.${c}`)
		.join("");
	return `${tag.toLowerCase()}${id}${classes}`.slice(0, 120);
}

/**
 * What the agent gets about the element, beside the person's text: the
 * screenshot's place, the DOM path, the probable sources, the styles and
 * the HTML. Plain text, quoted as page data when the prompt is assembled.
 */
export function composeContext(
	node: PointedNode,
	candidates: readonly SourceCandidate[],
	screenshot: string | null,
	limit = 8000,
): string {
	const lines: string[] = [];
	lines.push(`Element: ${selectorOf(node.tag, node.attributes)}`);
	if (node.url) lines.push(`Page: ${node.url.slice(0, 300)}`);
	if (node.path.length > 0) {
		lines.push(`DOM path: ${[...node.path].reverse().join(" > ")} > ${node.tag.toLowerCase()}`);
	}
	if (screenshot) lines.push(`Screenshot of the element: ${screenshot} (in the spec directory)`);
	if (candidates.length > 0) {
		lines.push("Probable source files (found by the element's markers, verify before editing):");
		for (const c of candidates) lines.push(`- ${c.path}:${c.line} (${c.markers.join(", ")})`);
	} else {
		lines.push("No source file contains this element's markers: search the code for it.");
	}
	const styles = STYLE_PROPERTIES.filter((p) => node.styles[p])
		.map((p) => `${p}: ${node.styles[p]}`)
		.join("; ");
	if (styles) lines.push(`Computed style: ${styles}`);
	const html =
		node.outerHtml.length > MAX_OUTER_HTML
			? `${node.outerHtml.slice(0, MAX_OUTER_HTML)}…`
			: node.outerHtml;
	lines.push("HTML:", html);
	return lines.join("\n").slice(0, limit);
}
