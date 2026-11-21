// @vitest-environment jsdom
/**
 * Every card type stays readable on every theme: the colours are mixed with
 * the theme surfaces read from styles/globals.css itself, so a theme added
 * or retuned there is checked here without anyone remembering to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_TYPES } from "../../shared/constants/card-types";
import {
	AA_TEXT,
	buildCardTypeCss,
	cardTypeTokens,
	contrastRatio,
	installCardTypeStylesheet,
	mixColors,
	parseColor,
	readThemeSurfaces,
	resetCardTypeStylesheetForTests,
	type ThemeSurfaces,
} from "./card-type-tokens";

const CSS = readFileSync(
	join(__dirname, "..", "styles", "globals.css"),
	"utf-8",
);

function themes(): Record<string, ThemeSurfaces> {
	const out: Record<string, ThemeSurfaces> = {};
	const block = /(?:^|\n)(:root|\.dark|\[data-theme="\w+"\](?:\.dark)?)\s*\{([^}]*)\}/g;
	for (const m of CSS.matchAll(block)) {
		const body = m[2];
		const read = (name: string) =>
			new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1].trim() ?? "";
		const surfaces = {
			card: read("card"),
			foreground: read("foreground"),
			mutedForeground: read("muted-foreground"),
			border: read("border"),
		};
		if (Object.values(surfaces).every((v) => parseColor(v)) && !out[m[1]]) {
			out[m[1]] = surfaces;
		}
	}
	return out;
}

describe("card type colours", () => {
	afterEach(() => {
		resetCardTypeStylesheetForTests();
		document.getElementById("kanban-card-type-colors")?.remove();
		document.documentElement.removeAttribute("style");
	});

	it("reads all seven themes in light and dark", () => {
		expect(Object.keys(themes())).toHaveLength(14);
	});

	it("keeps every text at AA on every theme, at both intensities, faded or not", () => {
		const failures: string[] = [];
		for (const [name, theme] of Object.entries(themes())) {
			for (const { id, color } of CARD_TYPES) {
				for (const intensity of ["subtle", "strong"] as const) {
					for (const faded of [false, true]) {
						const k = cardTypeTokens(theme, id, color, intensity, faded);
						for (const [what, ratio] of [
							["title", k.titleContrast],
							["description", k.descContrast],
							["chip", k.chipContrast],
						] as const) {
							if (ratio < AA_TEXT) {
								failures.push(`${name} ${id} ${intensity} ${what} ${ratio.toFixed(2)}`);
							}
						}
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps a colour the user might pick readable too", () => {
		const theme = themes()['[data-theme="forest"].dark'];
		for (const pick of ["#FFFF00", "#000080", "#22C55E", "#FFFFFF"]) {
			const k = cardTypeTokens(theme, "test", pick);
			expect(k.chipContrast).toBeGreaterThanOrEqual(AA_TEXT);
			expect(k.descContrast).toBeGreaterThanOrEqual(AA_TEXT);
		}
	});

	it("mixes like color-mix in oklab and measures like WCAG", () => {
		expect(mixColors("#FF0000", "#0000FF", 1)).toBe("#ff0000");
		expect(mixColors("#FF0000", "#0000FF", 0)).toBe("#0000ff");
		expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
		expect(parseColor("rgb(255, 0, 0)")).toEqual([1, 0, 0]);
		expect(parseColor("oklch(0.5 0.1 200)")).toBeNull();
	});

	it("writes one rule per type, a faded variant, and the chip on its own", () => {
		const theme = themes()[":root"];
		const css = buildCardTypeCss(theme);
		for (const { id } of CARD_TYPES) {
			expect(css).toContain(`.kanban-card[data-card-type="${id}"],[data-card-type-chip="${id}"]{`);
			expect(css).toContain(`.kanban-card[data-card-type="${id}"][data-card-faded]{`);
		}
	});

	it("installs once and follows a theme change", async () => {
		const root = document.documentElement;
		const set = (card: string) => {
			root.style.setProperty("--card", card);
			root.style.setProperty("--foreground", "#0B0B0F");
			root.style.setProperty("--muted-foreground", "#5C6974");
			root.style.setProperty("--border", "#DEDED9");
		};
		set("#FFFFFF");
		expect(readThemeSurfaces(root)?.card).toBe("#FFFFFF");
		installCardTypeStylesheet();
		installCardTypeStylesheet();
		expect(document.querySelectorAll("#kanban-card-type-colors")).toHaveLength(1);
		const before = document.getElementById("kanban-card-type-colors")?.textContent;
		set("#F0F0F0");
		root.dataset.theme = "dusk";
		await new Promise((r) => setTimeout(r, 0));
		const after = document.getElementById("kanban-card-type-colors")?.textContent;
		expect(after).not.toBe(before);
		delete root.dataset.theme;
	});
});
