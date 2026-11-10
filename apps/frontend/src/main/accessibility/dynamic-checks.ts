/**
 * What the dynamic accessibility scan concludes from a rendered page (#391).
 *
 * `dynamic-scan.ts` loads the app in a hidden, sandboxed window and collects
 * a trace: the accessibility tree Chromium builds, where the focus goes on
 * each Tab, the computed colours of visible text, the open dialogs. The page
 * is the project's code running, so the trace is untrusted data (S2): it is
 * reshaped here into plain fields of bounded size before any rule reads it,
 * and the rules are pure functions so they are tested without a browser.
 */
import type { A11ySeverity, A11yViolation, WcagLevel } from "../../shared/types/accessibility";
import { dynamicKey } from "../../shared/utils/a11y-keys";

export interface FocusStop {
	readonly tag: string;
	readonly label: string;
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
	readonly outlineVisible: boolean;
	readonly href: string;
	readonly inDialog: boolean;
}

export interface TextSample {
	readonly text: string;
	readonly color: string;
	readonly background: string | null;
	readonly fontSizePx: number;
	readonly fontWeight: number;
	readonly selector: string;
}

export interface AxNode {
	readonly role: string;
	readonly name: string;
	readonly ignored: boolean;
}

export interface DialogTrace {
	readonly label: string;
	/** Whether each Tab from inside the dialog left the focus inside it. */
	readonly stayedInside: boolean;
}

export interface PageTrace {
	readonly url: string;
	readonly lang: string;
	readonly title: string;
	readonly focus: readonly FocusStop[];
	readonly samples: readonly TextSample[];
	readonly ax: readonly AxNode[];
	readonly dialogs: readonly DialogTrace[];
	readonly skipTargetExists: boolean;
}

const MAX_STRING = 160;
const MAX_ITEMS = 2000;

function str(value: unknown, max = MAX_STRING): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : [];
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The page's answer reshaped into bounded plain fields; nothing else survives. */
export function sanitizeTrace(raw: unknown, url: string): PageTrace {
	const r = record(raw);
	return {
		url,
		lang: str(r.lang, 40),
		title: str(r.title),
		skipTargetExists: r.skipTargetExists === true,
		focus: list(r.focus).map((item) => {
			const f = record(item);
			return {
				tag: str(f.tag, 40).toLowerCase(),
				label: str(f.label),
				top: num(f.top),
				left: num(f.left),
				width: num(f.width),
				height: num(f.height),
				outlineVisible: f.outlineVisible !== false,
				href: str(f.href, 300),
				inDialog: f.inDialog === true,
			};
		}),
		samples: list(r.samples).map((item) => {
			const s = record(item);
			return {
				text: str(s.text, 60),
				color: str(s.color, 60),
				background: typeof s.background === "string" ? str(s.background, 60) : null,
				fontSizePx: num(s.fontSizePx),
				fontWeight: num(s.fontWeight),
				selector: str(s.selector),
			};
		}),
		ax: list(r.ax).map((item) => {
			const a = record(item);
			return { role: str(a.role, 40), name: str(a.name), ignored: a.ignored === true };
		}),
		dialogs: list(r.dialogs).map((item) => {
			const d = record(item);
			return { label: str(d.label), stayedInside: d.stayedInside !== false };
		}),
	};
}

// --- colours (WCAG 2.2 relative luminance) -----------------------------------

type Rgba = readonly [number, number, number, number];

export function parseRgb(value: string): Rgba | null {
	const match = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
	if (!match) return null;
	const alphaRaw = match[4];
	const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? Number.parseFloat(alphaRaw) / 100 : Number(alphaRaw);
	return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

function luminance([r, g, b]: Rgba): number {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg: Rgba, bg: Rgba): number | null {
	if (bg[3] < 1) return null;
	const a = fg[3];
	const blended: Rgba = [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
	const [hi, lo] = [luminance(blended), luminance(bg)].sort((x, y) => y - x);
	return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function isLarge(sample: TextSample): boolean {
	return sample.fontSizePx >= 24 || (sample.fontWeight >= 700 && sample.fontSizePx >= 18.66);
}

// --- rules -------------------------------------------------------------------

interface DynamicRule {
	readonly ruleId: string;
	readonly criterion: string;
	readonly level: WcagLevel;
	readonly severity: A11ySeverity;
	readonly description: string;
	readonly suggestion: string;
}

export const DYNAMIC_RULES: Record<string, DynamicRule> = {
	"ax-name": {
		ruleId: "ax-name",
		criterion: "4.1.2",
		level: "A",
		severity: "critical",
		description: "Control the screen reader announces without a name",
		suggestion: "Give it text, a label or aria-label",
	},
	"ax-image-name": {
		ruleId: "ax-image-name",
		criterion: "1.1.1",
		level: "A",
		severity: "critical",
		description: "Image the screen reader announces without a name",
		suggestion: 'Add alt text, or alt="" if it is decorative',
	},
	"page-lang": {
		ruleId: "page-lang",
		criterion: "3.1.1",
		level: "A",
		severity: "serious",
		description: "Page language not declared",
		suggestion: 'Set lang on <html>, for example lang="en"',
	},
	"page-title": {
		ruleId: "page-title",
		criterion: "2.4.2",
		level: "A",
		severity: "serious",
		description: "Page without a title",
		suggestion: "Set a document title that says what the page is",
	},
	"skip-link": {
		ruleId: "skip-link",
		criterion: "2.4.1",
		level: "A",
		severity: "moderate",
		description: "The first Tab stop does not skip to the content",
		suggestion: 'Make the first focusable element a link to the main content (href="#main")',
	},
	"focus-order": {
		ruleId: "focus-order",
		criterion: "2.4.3",
		level: "A",
		severity: "moderate",
		description: "Tab jumps back up the page",
		suggestion: "Order the markup as it reads, and avoid positive tabindex",
	},
	"focus-visible": {
		ruleId: "focus-visible",
		criterion: "2.4.7",
		level: "AA",
		severity: "serious",
		description: "Focused element shows no focus indicator",
		suggestion: "Keep the outline or give :focus-visible a ring",
	},
	"no-focusable": {
		ruleId: "no-focusable",
		criterion: "2.1.1",
		level: "A",
		severity: "serious",
		description: "Nothing on the page can be reached with Tab",
		suggestion: "Use real links and buttons, or make controls focusable",
	},
	"dialog-focus": {
		ruleId: "dialog-focus",
		criterion: "2.4.3",
		level: "A",
		severity: "serious",
		description: "Focus leaves an open modal dialog",
		suggestion: "Keep the focus inside the dialog while it is open (inert background or a focus trap)",
	},
	"color-contrast": {
		ruleId: "color-contrast",
		criterion: "1.4.3",
		level: "AA",
		severity: "serious",
		description: "Rendered text contrast below 4.5:1 (3:1 for large text)",
		suggestion: "Darken the text or lighten the background",
	},
	"color-contrast-enhanced": {
		ruleId: "color-contrast-enhanced",
		criterion: "1.4.6",
		level: "AAA",
		severity: "minor",
		description: "Rendered text contrast below 7:1 (4.5:1 for large text)",
		suggestion: "Darken the text or lighten the background",
	},
	"target-size": {
		ruleId: "target-size",
		criterion: "2.5.8",
		level: "AA",
		severity: "moderate",
		description: "Focusable target smaller than 24×24 px",
		suggestion: "Make it at least 24×24 px, padding included",
	},
};

const LEVELS: Record<WcagLevel, number> = { A: 1, AA: 2, AAA: 3 };
const NAMED_ROLES = new Set([
	"button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "textbox", "combobox",
	"searchbox", "slider", "spinbutton", "listbox", "option",
]);
const IMAGE_ROLES = new Set(["image", "img"]);
const MAX_PER_RULE = 25;

function violation(rule: DynamicRule, page: string, element: string, detail = ""): A11yViolation {
	return {
		ruleId: rule.ruleId,
		description: rule.description,
		severity: rule.severity,
		wcagLevel: rule.level,
		wcagCriteria: rule.criterion,
		file: page,
		line: 0,
		element: element.slice(0, 120),
		suggestion: rule.suggestion,
		detail,
		conditional: false,
		external: false,
		fixId: "",
		fix: null,
		dynamic: true,
	};
}

function describe(stop: FocusStop): string {
	return stop.label ? `<${stop.tag}> ${stop.label}` : `<${stop.tag}>`;
}

/** The violations a page trace shows, at or below `level`. */
export function analyseTrace(trace: PageTrace, level: WcagLevel): A11yViolation[] {
	let page = trace.url;
	try {
		const u = new URL(trace.url);
		page = `${u.pathname}${u.search}` || "/";
	} catch {
		// keep the url as given
	}
	const out: A11yViolation[] = [];
	const R = DYNAMIC_RULES;
	if (!trace.lang) out.push(violation(R["page-lang"], page, "<html>"));
	if (!trace.title) out.push(violation(R["page-title"], page, "<title>"));

	let named = 0;
	let images = 0;
	for (const node of trace.ax) {
		if (node.ignored || node.name) continue;
		if (NAMED_ROLES.has(node.role) && named < MAX_PER_RULE) {
			named += 1;
			out.push(violation(R["ax-name"], page, `role=${node.role}`));
		} else if (IMAGE_ROLES.has(node.role) && images < MAX_PER_RULE) {
			images += 1;
			out.push(violation(R["ax-image-name"], page, `role=${node.role}`));
		}
	}

	const stops = trace.focus;
	if (stops.length === 0) {
		out.push(violation(R["no-focusable"], page, "<body>"));
	} else {
		const first = stops[0];
		if (!(first.tag === "a" && first.href.startsWith("#") && trace.skipTargetExists) && stops.length > 5) {
			out.push(violation(R["skip-link"], page, describe(first)));
		}
	}
	let backwards = 0;
	let hidden = 0;
	let small = 0;
	for (let i = 0; i < stops.length; i += 1) {
		const stop = stops[i];
		const prev = stops[i - 1];
		if (prev && !stop.inDialog && !prev.inDialog && stop.top < prev.top - 80 && backwards < MAX_PER_RULE) {
			backwards += 1;
			out.push(violation(R["focus-order"], page, describe(stop), `after ${describe(prev)}`));
		}
		if (!stop.outlineVisible && hidden < MAX_PER_RULE) {
			hidden += 1;
			out.push(violation(R["focus-visible"], page, describe(stop)));
		}
		const inline = stop.tag === "a" && stop.height > 0 && stop.height < 24 && stop.width > 24;
		if (stop.width > 0 && stop.height > 0 && Math.min(stop.width, stop.height) < 24 && !inline && small < MAX_PER_RULE) {
			small += 1;
			out.push(
				violation(R["target-size"], page, describe(stop), `${Math.round(stop.width)}×${Math.round(stop.height)} px`),
			);
		}
	}
	for (const dialog of trace.dialogs) {
		if (!dialog.stayedInside) out.push(violation(R["dialog-focus"], page, dialog.label || "dialog"));
	}

	let lowContrast = 0;
	for (const sample of trace.samples) {
		if (lowContrast >= MAX_PER_RULE || !sample.background) continue;
		const fg = parseRgb(sample.color);
		const bg = parseRgb(sample.background);
		if (!fg || !bg) continue;
		const ratio = contrastRatio(fg, bg);
		if (ratio === null) continue;
		const large = isLarge(sample);
		const detail = `${sample.color} on ${sample.background}: ${ratio}:1`;
		const where = sample.selector || sample.text;
		if (ratio < (large ? 3 : 4.5)) {
			lowContrast += 1;
			out.push(violation(R["color-contrast"], page, where, detail));
		} else if (level === "AAA" && ratio < (large ? 4.5 : 7)) {
			lowContrast += 1;
			out.push(violation(R["color-contrast-enhanced"], page, where, detail));
		}
	}
	// The same finding on the same element twice says nothing more.
	const seen = new Set<string>();
	return out.filter((v) => {
		const key = dynamicKey(v);
		if (seen.has(key) || LEVELS[v.wcagLevel] > LEVELS[level]) return false;
		seen.add(key);
		return true;
	});
}

/**
 * The address the scan may open: the app running on this computer, never a
 * site on the internet (the page is loaded with the project's own code, and
 * nothing it does should reach further than the computer it runs on).
 */
export function validateScanUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 2000) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	const local =
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "[::1]" ||
		/^127(?:\.\d{1,3}){3}$/.test(host);
	return local ? url.toString() : null;
}
