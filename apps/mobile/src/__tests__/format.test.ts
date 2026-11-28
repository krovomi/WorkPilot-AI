import { dateLocale, formatDate, formatDay } from "../ui/format";

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

describe("formatDay", () => {
	it("writes a server day the way the app's language does, on that very day", () => {
		expect(formatDay("2026-11-28", "fr")).toBe("28/11/2026");
		expect(formatDay("2026-11-28", "en")).toBe("11/28/2026");
	});

	it("leaves anything that is not a day as it was", () => {
		expect(formatDay("2026-11", "fr")).toBe("2026-11");
	});
});
