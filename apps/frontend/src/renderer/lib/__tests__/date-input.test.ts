/**
 * What the date, month and time fields write and read: French puts the day
 * first and a 24-hour clock, English keeps month/day/year and AM/PM.
 */
import { describe, expect, it } from "vitest";
import {
	calendarCells,
	dayOf,
	formatDayField,
	formatMonthField,
	formatTimeField,
	isoDay,
	isoMonth,
	monthNames,
	monthTitle,
	parseDayField,
	parseIsoDay,
	parseIsoMonth,
	parseIsoTime,
	parseTimeField,
	shiftDay,
	shiftMonth,
	timeSlots,
	weekStart,
	weekdayNames,
	withinBounds,
} from "../date-input";

describe("days", () => {
	it("writes a day the way the language does", () => {
		expect(formatDayField("2026-11-28", "fr")).toBe("28/11/2026");
		expect(formatDayField("2026-11-28", "en")).toBe("11/28/2026");
		expect(formatDayField("2026-03-05", "fr-FR")).toBe("05/03/2026");
		expect(formatDayField("", "fr")).toBe("");
		expect(formatDayField("2026-02-31", "fr")).toBe("");
	});

	it("reads a typed day in the language's order", () => {
		expect(parseDayField("28/11/2026", "fr")).toBe("2026-11-28");
		expect(parseDayField("5.3.2026", "fr")).toBe("2026-03-05");
		expect(parseDayField("11/28/2026", "en")).toBe("2026-11-28");
		expect(parseDayField("3-5-2026", "en")).toBe("2026-03-05");
		expect(parseDayField("28112026", "fr")).toBe("2026-11-28");
		expect(parseDayField("11282026", "en")).toBe("2026-11-28");
		expect(parseDayField(" 2026-11-28 ", "fr")).toBe("2026-11-28");
	});

	it("tells an empty field from a wrong one", () => {
		expect(parseDayField("   ", "fr")).toBe("");
		expect(parseDayField("28/11", "fr")).toBeNull();
		expect(parseDayField("28/11/26", "fr")).toBeNull();
		expect(parseDayField("aa/bb/cccc", "fr")).toBeNull();
		expect(parseDayField("11/28/2026", "fr")).toBeNull();
		expect(parseDayField("2026-02-30", "en")).toBeNull();
		expect(parseDayField("31/02/2026", "fr")).toBeNull();
		expect(parseDayField("01/01/0999", "fr")).toBeNull();
		expect(parseDayField("13/01/2026", "en")).toBeNull();
		expect(parseDayField("00/01/2026", "fr")).toBeNull();
	});

	it("reads and writes YYYY-MM-DD", () => {
		expect(parseIsoDay("2026-11-28")).toEqual({ year: 2026, month: 11, day: 28 });
		expect(parseIsoDay("2026-11")).toBeNull();
		expect(parseIsoDay(undefined)).toBeNull();
		expect(isoDay({ year: 2026, month: 3, day: 5 })).toBe("2026-03-05");
		expect(dayOf(new Date(2026, 0, 9, 23, 30))).toBe("2026-01-09");
		expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
		expect(shiftDay("2026-03-01", -7)).toBe("2026-02-22");
	});

	it("keeps a value within its bounds", () => {
		expect(withinBounds("2026-11-28")).toBe(true);
		expect(withinBounds("2026-11-28", "2026-11-01", "2026-11-30")).toBe(true);
		expect(withinBounds("2026-10-31", "2026-11-01")).toBe(false);
		expect(withinBounds("2026-12", undefined, "2026-11")).toBe(false);
	});
});

describe("the calendar", () => {
	it("starts the week on Monday in French and Sunday in English", () => {
		expect(weekStart("fr")).toBe(1);
		expect(weekStart("en")).toBe(0);
		expect(weekdayNames("fr")[0]).toBe("lun.");
		expect(weekdayNames("en")[0]).toBe("Sun");
		expect(weekdayNames("fr")).toHaveLength(7);
	});

	it("lays out six weeks around the month", () => {
		// November 2026 starts on a Sunday.
		const fr = calendarCells(2026, 11, "fr");
		expect(fr).toHaveLength(42);
		expect(fr[0]).toEqual({ day: "2026-10-26", inMonth: false });
		expect(fr[6]).toEqual({ day: "2026-11-01", inMonth: true });
		const en = calendarCells(2026, 11, "en");
		expect(en[0]).toEqual({ day: "2026-11-01", inMonth: true });
		expect(en[41]).toEqual({ day: "2026-12-12", inMonth: false });
	});

	it("names months in the language", () => {
		expect(monthTitle(2026, 11, "fr")).toBe("novembre 2026");
		expect(monthTitle(2026, 11, "en")).toBe("November 2026");
		expect(monthNames("fr")[0]).toBe("janv.");
		expect(monthNames("en")[11]).toBe("Dec");
		expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
		expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
	});
});

describe("months", () => {
	it("reads and writes YYYY-MM", () => {
		expect(parseIsoMonth("2026-11")).toEqual({ year: 2026, month: 11 });
		expect(parseIsoMonth("2026-13")).toBeNull();
		expect(parseIsoMonth("2026-00")).toBeNull();
		expect(parseIsoMonth("0999-01")).toBeNull();
		expect(parseIsoMonth(null)).toBeNull();
		expect(isoMonth(2026, 3)).toBe("2026-03");
		expect(formatMonthField("2026-10", "fr")).toBe("octobre 2026");
		expect(formatMonthField("2026-10", "en")).toBe("October 2026");
		expect(formatMonthField("", "fr")).toBe("");
	});
});

describe("times", () => {
	it("writes a 24-hour clock in French and AM/PM in English", () => {
		expect(formatTimeField("14:30", "fr")).toBe("14:30");
		expect(formatTimeField("14:30", "en")).toBe("02:30 PM");
		expect(formatTimeField("00:05", "en")).toBe("12:05 AM");
		expect(formatTimeField("12:00", "en")).toBe("12:00 PM");
		expect(formatTimeField("09:00", "en")).toBe("09:00 AM");
		expect(formatTimeField("", "fr")).toBe("");
		expect(formatTimeField("24:00", "fr")).toBe("");
		expect(formatTimeField("10:60", "fr")).toBe("");
	});

	it("reads the ways a time gets typed", () => {
		expect(parseTimeField("14:30")).toBe("14:30");
		expect(parseTimeField("14h30")).toBe("14:30");
		expect(parseTimeField("14h")).toBe("14:00");
		expect(parseTimeField("1430")).toBe("14:30");
		expect(parseTimeField("9")).toBe("09:00");
		expect(parseTimeField("2:30 pm")).toBe("14:30");
		expect(parseTimeField("2PM")).toBe("14:00");
		expect(parseTimeField("12:15 am")).toBe("00:15");
		expect(parseTimeField("12 p")).toBe("12:00");
		expect(parseTimeField(" ")).toBe("");
	});

	it("refuses what is not a time", () => {
		expect(parseTimeField("25:00")).toBeNull();
		expect(parseTimeField("10:75")).toBeNull();
		expect(parseTimeField("13 pm")).toBeNull();
		expect(parseTimeField("0 am")).toBeNull();
		expect(parseTimeField("noon")).toBeNull();
	});

	it("reads HH:MM and lists the half hours", () => {
		expect(parseIsoTime("07:45")).toEqual({ hours: 7, minutes: 45 });
		expect(parseIsoTime("7:45")).toBeNull();
		expect(parseIsoTime(undefined)).toBeNull();
		const slots = timeSlots();
		expect(slots).toHaveLength(48);
		expect(slots.slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
		expect(slots.at(-1)).toBe("23:30");
	});
});
