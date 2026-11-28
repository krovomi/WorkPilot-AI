/**
 * Colours of the Kanban card types for the active theme.
 *
 * Each type has one base hue (`shared/constants/card-types.ts`). Its glow,
 * edge, chip and the grey of the description are mixed here with the
 * theme's own surfaces, in oklab like CSS `color-mix(in oklab, …)`, and the
 * text colours are pushed toward the theme foreground until they reach
 * WCAG AA (4.5:1) on the surface they sit on. A theme with coloured cards
 * (Forest, Ocean, Retro in dark mode) or a colour picked by the user later
 * therefore never produces an unreadable chip.
 *
 * The result is one generated stylesheet (`installCardTypeStylesheet`),
 * rebuilt when the root's theme class or `data-theme` changes: cards only
 * carry `data-card-type`, so the memoised board does not re-render.
 * Static rules (gradient, edge, hatching) live in styles/globals.css.
 */
import {
	CARD_TYPES,
	type CardType,
} from "../../shared/constants/card-types";

export interface ThemeSurfaces {
	card: string;
	foreground: string;
	mutedForeground: string;
	border: string;
}

export type CardTypeIntensity = "subtle" | "strong";

export interface CardTypeTokens {
	base: string;
	halo: string;
	edge: string;
	line: string;
	chipBg: string;
	chipBorder: string;
	chipFg: string;
	desc: string;
	/** Contrasts of the text actually drawn, for the tests and the docs. */
	titleContrast: number;
	descContrast: number;
	chipContrast: number;
}

type Rgb = [number, number, number];

export const AA_TEXT = 4.5;

/** Glow strength at its corner, and how much of it lies under text. */
const HALO: Record<CardTypeIntensity, number> = { subtle: 0.2, strong: 0.34 };
const UNDER_TEXT = 0.55;
/** The one type that must stand out is drawn strong whatever the setting. */
const ALWAYS_STRONG: ReadonlySet<CardType> = new Set<CardType>(["hotfix"]);

export function parseColor(value: string): Rgb | null {
	const v = value.trim();
	const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
	if (hex) {
		let h = hex[1];
		if (h.length === 3 || h.length === 4) {
			h = h
				.slice(0, 3)
				.split("")
				.map((c) => c + c)
				.join("");
		}
		if (h.length !== 6 && h.length !== 8) return null;
		return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
	}
	const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
	if (rgb) {
		return [rgb[1], rgb[2], rgb[3]].map((n) => Number(n) / 255) as Rgb;
	}
	return null;
}

const toLinear = (c: number) =>
	c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const fromLinear = (c: number) =>
	c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

function toOklab([r, g, b]: Rgb): Rgb {
	const R = toLinear(r);
	const G = toLinear(g);
	const B = toLinear(b);
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function fromOklab([L, a, b]: Rgb): Rgb {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	].map((c) => Math.min(1, Math.max(0, fromLinear(c)))) as Rgb;
}

const toHex = (c: Rgb) =>
	`#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;

function rgbOf(color: string): Rgb {
	return parseColor(color) ?? [0, 0, 0];
}

/** `share` of `a`, the rest of `b`, mixed in oklab. */
export function mixColors(a: string, b: string, share: number): string {
	const A = toOklab(rgbOf(a));
	const B = toOklab(rgbOf(b));
	return toHex(fromOklab(A.map((v, i) => v * share + B[i] * (1 - share)) as Rgb));
}

function luminance(color: string): number {
	const [r, g, b] = rgbOf(color).map(toLinear);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * `color`, moved toward `foreground` only as far as `min` (AA by default) on
 * `background` needs.
 */
export function readable(
	color: string,
	foreground: string,
	background: string,
	startShare: number,
	min = AA_TEXT,
): string {
	for (let share = startShare; share >= 0; share -= 0.04) {
		const c = mixColors(color, foreground, share);
		if (contrastRatio(c, background) >= min) return c;
	}
	return foreground;
}

function alpha(color: string, a: number): string {
	const [r, g, b] = rgbOf(color).map((v) => Math.round(v * 255));
	return `rgb(${r} ${g} ${b} / ${Math.round(a * 1000) / 1000})`;
}

/**
 * Tokens of one type on one theme. `faded` halves the glow (done cards and
 * proposed types), never the chip text, which stays AA.
 */
export function cardTypeTokens(
	theme: ThemeSurfaces,
	type: CardType,
	base: string,
	intensity: CardTypeIntensity = "subtle",
	faded = false,
): CardTypeTokens {
	const level = ALWAYS_STRONG.has(type) ? "strong" : intensity;
	const glow = HALO[level] * (faded ? 0.5 : 1);
	const underText = mixColors(base, theme.card, glow * UNDER_TEXT);
	const chipBg = mixColors(base, theme.card, 0.15);
	const chipFg = readable(base, theme.foreground, chipBg, 0.72);
	const desc = readable(theme.mutedForeground, theme.foreground, underText, 1);
	return {
		base,
		halo: alpha(base, glow),
		edge: alpha(base, Math.min(1, 0.55 + glow)),
		line: mixColors(base, theme.border, 0.06 + 0.22 * (faded ? 0.5 : 1)),
		chipBg,
		chipBorder: mixColors(base, theme.card, 0.38),
		chipFg,
		desc,
		titleContrast: contrastRatio(theme.foreground, underText),
		descContrast: contrastRatio(desc, underText),
		chipContrast: contrastRatio(chipFg, chipBg),
	};
}

function declarations(t: CardTypeTokens): string {
	return [
		`--ct-base:${t.base}`,
		`--ct-halo:${t.halo}`,
		`--ct-edge:${t.edge}`,
		`--ct-line:${t.line}`,
		`--ct-chip-bg:${t.chipBg}`,
		`--ct-chip-border:${t.chipBorder}`,
		`--ct-chip-fg:${t.chipFg}`,
		`--ct-desc:${t.desc}`,
	].join(";");
}

/** The generated rules for every type on `theme`. */
export function buildCardTypeCss(
	theme: ThemeSurfaces,
	colors: Partial<Record<CardType, string>> = {},
	intensity: CardTypeIntensity = "subtle",
): string {
	return CARD_TYPES.map(({ id, color }) => {
		const base = colors[id] ?? color;
		const sel = `.kanban-card[data-card-type="${id}"]`;
		// The chip carries its own colours too: the hover preview shows it
		// outside any card.
		const chip = `[data-card-type-chip="${id}"]`;
		const full = cardTypeTokens(theme, id, base, intensity);
		const faded = cardTypeTokens(theme, id, base, intensity, true);
		return `${sel},${chip}{${declarations(full)}}\n${sel}[data-card-faded]{${declarations(faded)}}`;
	}).join("\n");
}

/** The theme's surfaces as the root element resolves them, or null. */
export function readThemeSurfaces(root: HTMLElement): ThemeSurfaces | null {
	const style = getComputedStyle(root);
	const read = (name: string) => style.getPropertyValue(name).trim();
	const surfaces = {
		card: read("--card"),
		foreground: read("--foreground"),
		mutedForeground: read("--muted-foreground"),
		border: read("--border"),
	};
	return Object.values(surfaces).every((v) => parseColor(v))
		? surfaces
		: null;
}

const STYLE_ID = "kanban-card-type-colors";
let installed = false;

function refresh(doc: Document): void {
	const surfaces = readThemeSurfaces(doc.documentElement);
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
	el.textContent = buildCardTypeCss(surfaces);
}

/**
 * Writes the type colours once for the window and keeps them in step with
 * the theme. Idempotent: every card may call it.
 */
export function installCardTypeStylesheet(doc: Document = document): void {
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
export function resetCardTypeStylesheetForTests(): void {
	installed = false;
}
