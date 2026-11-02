/**
 * Dates follow the language chosen in the app (Leub, 2026-11-02: "mets les
 * dates au format FR lorsqu'on est en français mais garde le format US
 * lorsqu'on est en anglais").
 *
 * Before, most screens called `toLocaleString()` with no locale, so a date
 * followed the operating system's region (a French app on an English Windows
 * wrote 11/2/2026, 4:30 PM), and a few hardcoded "en-US" (GitHub/GitLab issues
 * and merge requests, PR logs). Every renderer date now goes through
 * `renderer/lib/date-format.ts`, and the guard below keeps it that way.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../shared/i18n";
import {
	dateLocale,
	formatDateIn,
	formatDateTimeIn,
	formatTimeIn,
	toValidDate,
} from "../../../shared/utils/date-format";
import {
	appDateLocale,
	formatAppDate,
	formatAppDateTime,
	formatAppDayLabel,
	formatAppTime,
} from "../date-format";

// Local time, so the expected strings do not depend on the machine's zone.
const NOV_2 = new Date(2026, 10, 2, 16, 30, 5);

describe("dateLocale", () => {
	it("maps French to fr-FR and English or anything else to en-US", () => {
		expect(dateLocale("fr")).toBe("fr-FR");
		expect(dateLocale("FR-ca")).toBe("fr-FR");
		expect(dateLocale("en")).toBe("en-US");
		expect(dateLocale("en-GB")).toBe("en-US");
		expect(dateLocale("de")).toBe("en-US");
		expect(dateLocale(undefined)).toBe("en-US");
		expect(dateLocale(null)).toBe("en-US");
	});
});

describe("formatting with an explicit language", () => {
	it("puts the day first in French and the month first in English", () => {
		expect(formatDateIn(NOV_2, "fr")).toBe("02/11/2026");
		expect(formatDateIn(NOV_2, "en")).toBe("11/2/2026");
	});

	it("writes a 24-hour clock in French and AM/PM in English", () => {
		expect(formatTimeIn(NOV_2, "fr", { hour: "2-digit", minute: "2-digit" })).toBe("16:30");
		expect(formatTimeIn(NOV_2, "en", { hour: "2-digit", minute: "2-digit" })).toMatch(
			/^04:30\sPM$/,
		);
		expect(formatDateTimeIn(NOV_2, "fr")).toBe("02/11/2026 16:30:05");
		expect(formatDateTimeIn(NOV_2, "en")).toMatch(/^11\/2\/2026, 4:30:05\sPM$/);
	});

	it("passes the options through (short month names in each language)", () => {
		const opts = { month: "short", day: "numeric", year: "numeric" } as const;
		expect(formatDateIn(NOV_2, "fr", opts)).toBe("2 nov. 2026");
		expect(formatDateIn(NOV_2, "en", opts)).toBe("Nov 2, 2026");
	});

	it("accepts ISO strings and epoch milliseconds", () => {
		expect(formatDateIn(NOV_2.toISOString(), "fr")).toBe("02/11/2026");
		expect(formatDateIn(NOV_2.getTime(), "en")).toBe("11/2/2026");
	});

	it("returns an empty string instead of 'Invalid Date'", () => {
		for (const bad of [null, undefined, "", "not a date", Number.NaN]) {
			expect(toValidDate(bad)).toBeNull();
			expect(formatDateIn(bad, "fr")).toBe("");
			expect(formatDateTimeIn(bad, "en")).toBe("");
			expect(formatTimeIn(bad, "en")).toBe("");
		}
	});
});

describe("renderer helpers follow the app language", () => {
	afterEach(async () => {
		await i18n.changeLanguage("en");
	});

	it("switches format when the language changes", async () => {
		await i18n.changeLanguage("fr");
		expect(appDateLocale()).toBe("fr-FR");
		expect(formatAppDate(NOV_2)).toBe("02/11/2026");
		expect(formatAppDateTime(NOV_2)).toBe("02/11/2026 16:30:05");
		expect(formatAppTime(NOV_2, { hour: "2-digit", minute: "2-digit" })).toBe("16:30");

		await i18n.changeLanguage("en");
		expect(appDateLocale()).toBe("en-US");
		expect(formatAppDate(NOV_2)).toBe("11/2/2026");
	});

	it("names today and yesterday, then writes a short date", async () => {
		await i18n.changeLanguage("fr");
		expect(formatAppDayLabel("2026-11-02", NOV_2)).toBe("Aujourd'hui");
		expect(formatAppDayLabel("2026-11-01", NOV_2)).toBe("Hier");
		expect(formatAppDayLabel("2026-10-25", NOV_2)).toBe("25 oct.");

		await i18n.changeLanguage("en");
		expect(formatAppDayLabel("2026-11-02", NOV_2)).toBe("Today");
		expect(formatAppDayLabel("2026-11-01", NOV_2)).toBe("Yesterday");
		expect(formatAppDayLabel("2026-10-25", NOV_2)).toBe("Oct 25");
		expect(formatAppDayLabel("garbage", NOV_2)).toBe("garbage");
	});
});

describe("guard: renderer dates go through renderer/lib/date-format.ts", () => {
	const rendererRoot = path.resolve(__dirname, "../..");
	const helper = path.resolve(__dirname, "../date-format.ts");

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				return ["__tests__", "mocks", "node_modules"].includes(entry.name)
					? []
					: sourceFiles(full);
			}
			const isSource = /\.(ts|tsx)$/.test(entry.name);
			const isTest = /\.(test|spec)\.(ts|tsx)$/.test(entry.name);
			return isSource && !isTest && full !== helper ? [full] : [];
		});
	}

	// A date written with the OS region, or with a hardcoded locale.
	const FORBIDDEN: { name: string; pattern: RegExp }[] = [
		{ name: "toLocaleDateString(", pattern: /\.toLocaleDateString\(/ },
		{ name: "toLocaleTimeString(", pattern: /\.toLocaleTimeString\(/ },
		{ name: "new Date(...).toLocaleString(", pattern: /new Date\([^;]*?\)\s*\.toLocaleString\(/ },
		// Intl.DateTimeFormat is fine when it is given dateLocale(...) / appDateLocale().
		{
			name: "Intl.DateTimeFormat( without dateLocale",
			pattern: /Intl\.DateTimeFormat\((?!\s*(dateLocale|appDateLocale)\()/,
		},
	];

	it("finds no date formatted outside the helper", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(rendererRoot)) {
			const text = readFileSync(file, "utf-8");
			for (const { name, pattern } of FORBIDDEN) {
				if (pattern.test(text)) {
					offenders.push(`${path.relative(rendererRoot, file)}: ${name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
