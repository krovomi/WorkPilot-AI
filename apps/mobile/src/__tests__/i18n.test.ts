import en from "../i18n/en.json";
import fr from "../i18n/fr.json";
import { describeError, pickLanguage } from "../i18n";
import { ApiError } from "../api/client";

function keys(value: unknown, prefix = ""): string[] {
	if (!value || typeof value !== "object") return [prefix];
	return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("i18n", () => {
	it("has every key in English and French", () => {
		expect(keys(fr).sort()).toEqual(keys(en).sort());
	});

	it("leaves no text empty", () => {
		for (const pack of [en, fr]) {
			const flat = keys(pack);
			for (const key of flat) {
				const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], pack);
				expect(typeof text === "string" && text.trim().length > 0).toBe(true);
			}
		}
	});

	it("picks the device's first language it speaks", () => {
		expect(pickLanguage(["de-DE", "fr-CA"])).toBe("fr");
		expect(pickLanguage(["ja"])).toBe("en");
		expect(pickLanguage([null, undefined])).toBe("en");
	});

	it("turns failures into sentences", () => {
		expect(describeError(new ApiError(0, "network"))).toBe(en.errors.network);
		expect(describeError(new ApiError(403, "Missing permission"))).toBe(en.errors.forbidden);
		expect(describeError(new ApiError(409, "Busy"))).toBe("Something went wrong: Busy");
		expect(describeError(new Error("feedback_required"))).toBe(en.errors.feedback_required);
	});
});
