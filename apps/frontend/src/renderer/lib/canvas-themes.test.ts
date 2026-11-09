import { describe, expect, it } from "vitest";
import {
	CANVAS_PRESETS,
	canvasThemeStyle,
	DEFAULT_CANVAS_PRESET,
	normalizeCanvasTheme,
} from "./canvas-themes";

describe("normalizeCanvasTheme", () => {
	it("keeps a known preset and hex colours only", () => {
		expect(
			normalizeCanvasTheme({
				preset: "midnight",
				colors: { flow: "#38bdf8", card: "url(x)", nope: "#000000" },
			}),
		).toEqual({ preset: "midnight", colors: { flow: "#38bdf8" } });
	});

	it("answers nothing for an empty or unknown theme", () => {
		expect(normalizeCanvasTheme(undefined)).toBeUndefined();
		expect(normalizeCanvasTheme({ preset: "nope" })).toBeUndefined();
		expect(normalizeCanvasTheme("ember")).toBeUndefined();
	});
});

describe("canvasThemeStyle", () => {
	it("leaves the default look, the app's colour theme, to the stylesheet", () => {
		expect(DEFAULT_CANVAS_PRESET).toBe("app");
		expect(canvasThemeStyle(undefined)).toEqual({});
		expect(canvasThemeStyle({ preset: "app" })).toEqual({});
	});

	it("keeps the theme's surfaces for an accent-only preset", () => {
		expect(canvasThemeStyle({ preset: "ember" })).toEqual({ "--vtc-flow": "#f26b2d" });
	});

	it("applies the preset, then the person's colours on top", () => {
		const style = canvasThemeStyle({
			preset: "paper",
			colors: { flow: "#123456", card: "#abcdef" },
		});
		const paper = CANVAS_PRESETS.find((p) => p.id === "paper");
		expect(style["--vtc-bg"]).toBe(paper?.tokens.background);
		expect(style["--vtc-flow"]).toBe("#123456");
		expect(style["--vtc-card"]).toBe("#abcdef");
		expect(style["--vtc-card-solid"]).toBe("#abcdef");
	});

});
