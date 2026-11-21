import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLanguage, LANGUAGE_KEY } from "../voice-language";

describe("the assistant's speech language", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	it("keeps the language chosen in the panel", () => {
		localStorage.setItem(LANGUAGE_KEY, "de-DE");
		expect(initialLanguage("fr")).toBe("de-DE");
	});

	it("ignores a saved value it does not know, and follows the app", () => {
		localStorage.setItem(LANGUAGE_KEY, "xx-YY");
		expect(initialLanguage("fr")).toBe("fr-FR");
		expect(initialLanguage("en-GB")).toBe("en-US");
	});

	it("detects the language when the app's is not offered, or storage is off", () => {
		vi.spyOn(localStorage, "getItem").mockImplementation(() => {
			throw new Error("disabled");
		});
		expect(initialLanguage("ja")).toBe("auto");
	});
});
