/**
 * Text colours of the Kanban column bands for the active theme.
 *
 * The band (styles/kanban-columns.css) is a wash of the column accent over
 * the card colour. Drawn in the raw accent, the big count can fall to 1.5:1
 * on it (cyan on a light theme), so its colour, the warning colour of a full
 * column and the icon of an empty column are moved toward the theme
 * foreground until they reach their contrast target, the way
 * lib/card-type-tokens.ts does for the card chips.
 *
 * One generated stylesheet, rebuilt when the root's theme changes; the
 * columns only carry `data-column-status`, so the memoised board does not
 * re-render. Without it (tests, a theme colour that cannot be parsed) the
 * CSS falls back to the foreground.
 */
import { TASK_STATUS_COLUMNS, type TaskStatusColumn } from "../../shared/constants/task";
import { contrastRatio, mixColors, parseColor, readable } from "./card-type-tokens";
import { COLUMN_ACCENTS } from "./kanban-column-meta";

/** Accent share of the band at its top, where text sits (kanban-columns.css). */
export const BAND_TOP = 0.22;
/** Accent share of the halo behind the icon of an empty column. */
export const EMPTY_HALO = 0.2;
/** WCAG 1.4.11: an icon is a graphic, 3:1 is its target. */
export const GRAPHIC_CONTRAST = 3;

export interface ColumnSurfaces {
	card: string;
	background: string;
	foreground: string;
	warning: string;
	/** Resolved value of each theme token an accent may name (`--info`…). */
	tokens: Record<string, string>;
}

export interface ColumnTokens {
	accent: string;
	band: string;
	/** The count and any accent text on the band. */
	ink: string;
	/** The count of a full or over-limit column, and a warning in its summary. */
	warnInk: string;
	/** The secondary text of the band: its summary line and gauge label. */
	muted: string;
	/** The glyph drawn on the solid accent tile. */
	onAccent: string;
	/** The icon of an empty column, on its halo. */
	icon: string;
}

const DARK_GLYPH = "#0B0B0F";
const LIGHT_GLYPH = "#FFFFFF";

export function columnAccent(
	status: TaskStatusColumn,
	surfaces: ColumnSurfaces,
): string | null {
	const accent = COLUMN_ACCENTS[status];
	const value = "color" in accent ? accent.color : surfaces.tokens[accent.token];
	return value && parseColor(value) ? value : null;
}

function mutedOf(s: ColumnSurfaces): string {
	const muted = s.tokens["--muted-foreground"];
	return muted && parseColor(muted) ? muted : s.foreground;
}

export function columnTokens(accent: string, s: ColumnSurfaces): ColumnTokens {
	const band = mixColors(accent, s.card, BAND_TOP);
	const columnSurface = mixColors(s.card, s.background, 0.4);
	const halo = mixColors(accent, columnSurface, EMPTY_HALO);
	return {
		accent,
		band,
		ink: readable(accent, s.foreground, band, 0.72),
		warnInk: readable(s.warning, s.foreground, band, 0.72),
		muted: readable(mutedOf(s), s.foreground, band, 1),
		onAccent:
			contrastRatio(DARK_GLYPH, accent) >= contrastRatio(LIGHT_GLYPH, accent)
				? DARK_GLYPH
				: LIGHT_GLYPH,
		icon: readable(accent, s.foreground, halo, 0.72, GRAPHIC_CONTRAST),
	};
}

export function buildColumnCss(s: ColumnSurfaces): string {
	return TASK_STATUS_COLUMNS.flatMap((status) => {
		const accent = columnAccent(status, s);
		if (!accent) return [];
		const t = columnTokens(accent, s);
		return [
			`.kanban-column[data-column-status="${status}"]{--col-ink:${t.ink};--col-warn-ink:${t.warnInk};--col-muted:${t.muted};--col-on:${t.onAccent};--col-icon:${t.icon}}`,
		];
	}).join("\n");
}

const ACCENT_TOKENS = [...new Set(
	Object.values(COLUMN_ACCENTS).flatMap((a) => ("token" in a ? [a.token] : [])),
)];

/** The theme colours as the root element resolves them, or null. */
export function readColumnSurfaces(root: HTMLElement): ColumnSurfaces | null {
	const style = getComputedStyle(root);
	const read = (name: string) => style.getPropertyValue(name).trim();
	const base = {
		card: read("--card"),
		background: read("--background"),
		foreground: read("--foreground"),
		warning: read("--warning"),
	};
	if (!Object.values(base).every((v) => parseColor(v))) return null;
	return {
		...base,
		tokens: Object.fromEntries(ACCENT_TOKENS.map((name) => [name, read(name)])),
	};
}

const STYLE_ID = "kanban-column-colors";
let installed = false;

function refresh(doc: Document): void {
	const surfaces = readColumnSurfaces(doc.documentElement);
	let el = doc.getElementById(STYLE_ID);
	if (!surfaces) {
		el?.remove();
		return;
	}
	if (!el) {
		el = doc.createElement("style");
		el.id = STYLE_ID;
		doc.head.appendChild(el);
	}
	el.textContent = buildColumnCss(surfaces);
}

/**
 * Writes the band colours once for the window and keeps them in step with
 * the theme. Idempotent: every column may call it.
 */
export function installColumnStylesheet(doc: Document = document): void {
	if (installed) return;
	installed = true;
	refresh(doc);
	const observer = new MutationObserver(() => refresh(doc));
	observer.observe(doc.documentElement, {
		attributes: true,
		attributeFilter: ["class", "data-theme", "style"],
	});
}

/** Tests only: forget the installation so a fresh document can be used. */
export function resetColumnStylesheetForTests(): void {
	installed = false;
}
