/** The Usage tab's periods (UTC days, both included) and number formats. */
import { describe, expect, it } from "vitest";
import { formatRate, formatUsd, periodOf } from "../usage-format";

describe("usage-format", () => {
	it("covers the days a preset names, ending today", () => {
		const now = new Date("2026-11-27T23:30:00Z");
		expect(periodOf("7d", now)).toEqual({ start: "2026-11-21", end: "2026-11-27" });
		expect(periodOf("30d", now)).toEqual({ start: "2026-10-29", end: "2026-11-27" });
		expect(periodOf("month", now)).toEqual({ start: "2026-11-01", end: "2026-11-27" });
		expect(periodOf("30d").end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("rounds large costs and shows no rate before any run ended", () => {
		expect(formatUsd(1234.56)).not.toMatch(/\.56|,56/);
		expect(formatUsd(1.5)).toMatch(/1[.,]50/);
		expect(formatRate(null)).toBe("–");
		expect(formatRate(0.5)).toMatch(/50/);
	});
});
