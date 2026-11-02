import { dateLocale, formatDate } from "../ui/format";

describe("dateLocale", () => {
	it("writes French dates the French way and everything else the US way", () => {
		expect(dateLocale("fr")).toBe("fr-FR");
		expect(dateLocale("fr-CA")).toBe("fr-FR");
		expect(dateLocale("en")).toBe("en-US");
		expect(dateLocale("en-GB")).toBe("en-US");
		expect(dateLocale(undefined)).toBe("en-US");
	});
});

describe("formatDate", () => {
	const iso = "2026-11-02T16:30:00";

	it("puts the day first in French and the month first in English", () => {
		expect(formatDate(iso, "fr")).toMatch(/^02\/11\/2026/);
		expect(formatDate(iso, "en")).toMatch(/^11\/2\/26/);
		expect(formatDate(iso, "fr")).toContain("16:30");
		expect(formatDate(iso, "en")).toMatch(/4:30\s?PM/);
	});

	it("gives nothing for a missing or broken date", () => {
		expect(formatDate(null, "fr")).toBe("");
		expect(formatDate("not a date", "en")).toBe("");
	});
});
