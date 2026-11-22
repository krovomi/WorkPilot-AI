// @vitest-environment jsdom
/**
 * The count, the warning and the icon of every column band stay readable on
 * every theme. The theme colours are read from styles/globals.css itself, so
 * a theme added or retuned there is checked without anyone remembering to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_STATUS_COLUMNS } from "../../shared/constants/task";
import { AA_TEXT, contrastRatio, mixColors, parseColor } from "./card-type-tokens";
import {
	BAND_TOP,
	buildColumnCss,
	type ColumnSurfaces,
	columnAccent,
	columnTokens,
	EMPTY_HALO,
	GRAPHIC_CONTRAST,
	installColumnStylesheet,
	readColumnSurfaces,
	resetColumnStylesheetForTests,
} from "./kanban-column-tokens";

const CSS = readFileSync(join(__dirname, "..", "styles", "globals.css"), "utf-8");
const TOKENS = ["--muted-foreground", "--info", "--warning", "--destructive", "--success"];

function themes(): Record<string, ColumnSurfaces> {
	const out: Record<string, ColumnSurfaces> = {};
	const block = /(?:^|\n)(:root|\.dark|\[data-theme="\w+"\](?:\.dark)?)\s*\{([^}]*)\}/g;
	for (const m of CSS.matchAll(block)) {
		const read = (name: string) =>
			new RegExp(`${name}:\\s*([^;]+);`).exec(m[2])?.[1].trim() ?? "";
		const surfaces: ColumnSurfaces = {
			card: read("--card"),
			background: read("--background"),
			foreground: read("--foreground"),
			warning: read("--warning"),
			tokens: Object.fromEntries(TOKENS.map((t) => [t, read(t)])),
		};
		const all = [surfaces.card, surfaces.background, surfaces.foreground, ...Object.values(surfaces.tokens)];
		if (all.every((v) => parseColor(v)) && !out[m[1]]) out[m[1]] = surfaces;
	}
	return out;
}

describe("column band colours", () => {
	afterEach(() => {
		resetColumnStylesheetForTests();
		document.getElementById("kanban-column-colors")?.remove();
		document.documentElement.removeAttribute("style");
	});

	it("reads all seven themes in light and dark", () => {
		expect(Object.keys(themes())).toHaveLength(14);
	});

	it("keeps the count, the warning and the icons readable on every theme", () => {
		const failures: string[] = [];
		for (const [name, theme] of Object.entries(themes())) {
			for (const status of TASK_STATUS_COLUMNS) {
				const accent = columnAccent(status, theme);
				expect(accent, `${name} ${status}`).not.toBeNull();
				const k = columnTokens(accent as string, theme);
				const halo = mixColors(accent as string, mixColors(theme.card, theme.background, 0.4), EMPTY_HALO);
				for (const [what, ratio, min] of [
					["count", contrastRatio(k.ink, k.band), AA_TEXT],
					["warning", contrastRatio(k.warnInk, k.band), AA_TEXT],
					["tile glyph", contrastRatio(k.onAccent, accent as string), GRAPHIC_CONTRAST],
					["empty icon", contrastRatio(k.icon, halo), GRAPHIC_CONTRAST],
				] as const) {
					if (ratio < min) failures.push(`${name} ${status} ${what} ${ratio.toFixed(2)}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("the band is the accent over the card at its top", () => {
		const theme = themes()[":root"];
		const k = columnTokens("#22d3ee", theme);
		expect(k.band).toBe(mixColors("#22d3ee", theme.card, BAND_TOP));
		expect(k.ink).not.toBe("#22d3ee");
	});

	it("writes one rule per column and skips an accent it cannot read", () => {
		const theme = themes()[":root"];
		const css = buildColumnCss(theme);
		for (const status of TASK_STATUS_COLUMNS) {
			expect(css).toContain(`.kanban-column[data-column-status="${status}"]{--col-ink:`);
		}
		const partial = { ...theme, tokens: { ...theme.tokens, "--info": "oklch(0.6 0.1 250)" } };
		expect(columnAccent("in_progress", partial)).toBeNull();
		expect(buildColumnCss(partial)).not.toContain('"in_progress"');
	});

	it("installs once, follows a theme change and steps aside without readable colours", async () => {
		const root = document.documentElement;
		const set = (card: string) => {
			root.style.setProperty("--card", card);
			root.style.setProperty("--background", "#F2F2ED");
			root.style.setProperty("--foreground", "#0B0B0F");
			root.style.setProperty("--warning", "#6E700A");
			for (const t of TOKENS) root.style.setProperty(t, "#066BD3");
		};
		set("#FFFFFF");
		expect(readColumnSurfaces(root)?.tokens["--info"]).toBe("#066BD3");
		installColumnStylesheet();
		installColumnStylesheet();
		expect(document.querySelectorAll("#kanban-column-colors")).toHaveLength(1);
		const before = document.getElementById("kanban-column-colors")?.textContent;
		set("#101010");
		root.dataset.theme = "dusk";
		await new Promise((r) => setTimeout(r, 0));
		expect(document.getElementById("kanban-column-colors")?.textContent).not.toBe(before);
		root.style.setProperty("--card", "oklch(0.5 0 0)");
		root.dataset.theme = "ocean";
		await new Promise((r) => setTimeout(r, 0));
		expect(document.getElementById("kanban-column-colors")).toBeNull();
		root.dataset.theme = "lime";
		await new Promise((r) => setTimeout(r, 0));
		expect(document.getElementById("kanban-column-colors")).toBeNull();
		delete root.dataset.theme;
	});
});
