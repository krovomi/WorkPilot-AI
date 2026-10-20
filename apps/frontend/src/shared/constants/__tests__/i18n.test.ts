import { describe, expect, it } from "vitest";
import { resolveInterfaceLanguage } from "../i18n";

/**
 * The app started in English until the user found Settings → Language, which
 * is what "it isn't translated" looks like from the outside when both locales
 * have shipped complete all along.
 */
describe("resolveInterfaceLanguage", () => {
	it.each([
		[["fr-FR", "fr", "en-US"], "fr"],
		[["fr"], "fr"],
		[["fr_CA"], "fr"],
		[["en-GB"], "en"],
		// Nothing translated in the list: English, not a half-translated screen.
		[["de-DE", "it"], "en"],
		[[], "en"],
		[[""], "en"],
	])("reads %j as %s", (locales, expected) => {
		expect(resolveInterfaceLanguage(locales)).toBe(expected);
	});

	it("takes the first locale the app actually speaks, in order", () => {
		expect(resolveInterfaceLanguage(["de", "fr", "en"])).toBe("fr");
	});
});
