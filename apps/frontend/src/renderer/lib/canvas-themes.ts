/**
 * canvas-themes — the colours of a Visual-to-Code canvas.
 *
 * The canvas is drawn from a handful of CSS tokens (`--vtc-*`, see
 * `flow-canvas.css`). A theme is a preset that sets some of them, plus the
 * colours the person picked themselves, which win over the preset. It is
 * stored on the architecture, so each document keeps its own look.
 *
 * Only a few tokens are set here; the rest (the bright core of a wire, the
 * light running on it, the warm glow in the corner, the secondary text) are
 * derived from these in the stylesheet, so one colour picked for the
 * connectors recolours everything that belongs to them.
 *
 * Pure, so it is unit testable.
 */

import { isAccent } from "./custom-bricks";

/** What the person can colour on a canvas. */
export const CANVAS_COLOR_KEYS = [
	"background",
	"grid",
	"card",
	"border",
	"text",
	"flow",
] as const;

export type CanvasColorKey = (typeof CANVAS_COLOR_KEYS)[number];

export type CanvasColors = Partial<Record<CanvasColorKey, string>>;

export interface CanvasPreset {
	id: string;
	labelKey: string;
	/** Swatch shown in the picker. */
	swatch: string;
	/** Token values; anything absent keeps the stylesheet's light/dark default. */
	tokens: Partial<Record<CanvasColorKey, string>>;
}

/**
 * Accent-only presets keep the stylesheet's surfaces, so they follow the
 * app's light or dark mode; `app` borrows the app's own colour theme, so a
 * canvas can match whichever of the app's themes is on.
 */
export const CANVAS_PRESETS: CanvasPreset[] = [
	{ id: "ember", labelKey: "canvasThemeEmber", swatch: "#f26b2d", tokens: {} },
	{
		id: "app",
		labelKey: "canvasThemeApp",
		swatch: "var(--primary)",
		tokens: {
			background: "var(--background)",
			card: "var(--card)",
			border: "var(--border)",
			text: "var(--foreground)",
			flow: "var(--primary)",
		},
	},
	{ id: "ocean", labelKey: "canvasThemeOcean", swatch: "#38bdf8", tokens: { flow: "#38bdf8" } },
	{ id: "violet", labelKey: "canvasThemeViolet", swatch: "#a78bfa", tokens: { flow: "#a78bfa" } },
	{ id: "emerald", labelKey: "canvasThemeEmerald", swatch: "#34d399", tokens: { flow: "#34d399" } },
	{ id: "rose", labelKey: "canvasThemeRose", swatch: "#fb7185", tokens: { flow: "#fb7185" } },
	{
		id: "midnight",
		labelKey: "canvasThemeMidnight",
		swatch: "#6366f1",
		tokens: {
			background: "#0b1020",
			grid: "#151c36",
			card: "#121a33",
			border: "#26305a",
			text: "#e6e9f5",
			flow: "#818cf8",
		},
	},
	{
		id: "paper",
		labelKey: "canvasThemePaper",
		swatch: "#fbf8f3",
		tokens: {
			background: "#fbf8f3",
			grid: "#f1ece4",
			card: "#ffffff",
			border: "#e2dacd",
			text: "#2b2622",
			flow: "#c2410c",
		},
	},
];

export const DEFAULT_CANVAS_PRESET = "ember";

export interface CanvasTheme {
	preset?: string;
	colors?: CanvasColors;
}

/** A stored theme as it may be trusted: known preset, `#rrggbb` colours only. */
export function normalizeCanvasTheme(theme: unknown): CanvasTheme | undefined {
	if (!theme || typeof theme !== "object") return undefined;
	const raw = theme as { preset?: unknown; colors?: unknown };
	const preset = CANVAS_PRESETS.some((p) => p.id === raw.preset)
		? (raw.preset as string)
		: undefined;
	const colors: CanvasColors = {};
	if (raw.colors && typeof raw.colors === "object") {
		for (const key of CANVAS_COLOR_KEYS) {
			const value = (raw.colors as Record<string, unknown>)[key];
			if (isAccent(value)) colors[key] = value;
		}
	}
	if (!preset && Object.keys(colors).length === 0) return undefined;
	return {
		...(preset ? { preset } : {}),
		...(Object.keys(colors).length > 0 ? { colors } : {}),
	};
}

const TOKEN: Record<CanvasColorKey, string[]> = {
	background: ["--vtc-bg"],
	grid: ["--vtc-grid"],
	card: ["--vtc-card", "--vtc-card-solid"],
	border: ["--vtc-card-border"],
	text: ["--vtc-title"],
	flow: ["--vtc-flow"],
};

/**
 * The inline style that applies a theme to the canvas element: the preset's
 * tokens, then the person's own colours on top. Empty for the default look.
 */
export function canvasThemeStyle(
	theme: CanvasTheme | undefined,
): Record<string, string> {
	const clean = normalizeCanvasTheme(theme);
	const preset = CANVAS_PRESETS.find((p) => p.id === clean?.preset);
	const values: CanvasColors = { ...preset?.tokens, ...clean?.colors };
	const style: Record<string, string> = {};
	for (const key of CANVAS_COLOR_KEYS) {
		const value = values[key];
		if (!value) continue;
		for (const token of TOKEN[key]) style[token] = value;
	}
	return style;
}
