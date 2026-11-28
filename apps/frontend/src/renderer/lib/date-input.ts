/**
 * What the app's date, month and time fields show and read, in the app's language.
 *
 * A native `<input type="date">` writes its value with the operating system's
 * region (mm/dd/yyyy on an English Windows) whatever language the app speaks,
 * so the fields in `components/ui/date-fields.tsx` draw their own text and
 * calendar from these helpers instead. The values stay the ones a native field
 * gives: `YYYY-MM-DD`, `YYYY-MM` and a 24-hour `HH:MM`. French reads and writes
 * 28/11/2026 and 14:30; English keeps the format it had, 11/28/2026 and 02:30 PM.
 */
import { dateLocale, formatDateIn } from "../../shared/utils/date-format";

export interface DayParts {
	year: number;
	month: number;
	day: number;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const ISO_TIME = /^(\d{2}):(\d{2})$/;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function isFrench(language: string | null | undefined): boolean {
	return dateLocale(language) === "fr-FR";
}

/** The YYYY-MM-DD of a day. */
export function isoDay({ year, month, day }: DayParts): string {
	return `${year}-${pad(month)}-${pad(day)}`;
}

/** The day a real calendar date names, or null (31/02 is not one). */
function realDay(year: number, month: number, day: number): DayParts | null {
	if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
	const date = new Date(year, month - 1, day);
	return date.getMonth() === month - 1 && date.getDate() === day ? { year, month, day } : null;
}

/** The parts of a YYYY-MM-DD value, or null when it is not a real day. */
export function parseIsoDay(value: string | null | undefined): DayParts | null {
	const match = ISO_DAY.exec(value ?? "");
	return match ? realDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/** The YYYY-MM-DD of a Date, in local time. */
export function dayOf(date: Date): string {
	return isoDay({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
}

/** A YYYY-MM-DD value as the field writes it: 28/11/2026 in French, 11/28/2026 in English. */
export function formatDayField(value: string, language: string | null | undefined): string {
	const parts = parseIsoDay(value);
	if (!parts) return "";
	return formatDateIn(new Date(parts.year, parts.month - 1, parts.day), language, {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	});
}

/**
 * What a typed date means: "" when the field is empty, the YYYY-MM-DD when it
 * names a real day, null otherwise. French reads day/month/year, English
 * month/day/year; both also take a pasted 2026-11-28 and eight bare digits.
 */
export function parseDayField(text: string, language: string | null | undefined): string | null {
	const trimmed = text.trim();
	if (!trimmed) return "";
	if (ISO_DAY.test(trimmed)) {
		const parts = parseIsoDay(trimmed);
		return parts ? isoDay(parts) : null;
	}
	let numbers: number[];
	if (/^\d{8}$/.test(trimmed)) {
		numbers = [trimmed.slice(0, 2), trimmed.slice(2, 4), trimmed.slice(4)].map(Number);
	} else {
		const pieces = trimmed.split(/[\s/.-]+/);
		if (pieces.length !== 3 || !pieces.every((piece) => /^\d+$/.test(piece)) || pieces[2].length !== 4) return null;
		numbers = pieces.map(Number);
	}
	const [first, second, year] = numbers;
	const parts = isFrench(language) ? realDay(year, second, first) : realDay(year, first, second);
	return parts ? isoDay(parts) : null;
}

/** The first day of the week: Monday in French, Sunday in English (as the native picker did). */
export function weekStart(language: string | null | undefined): 0 | 1 {
	return isFrench(language) ? 1 : 0;
}

/** The seven short weekday names, from the first day of the week ("lun." … / "Su" …). */
export function weekdayNames(language: string | null | undefined): string[] {
	const first = weekStart(language);
	// 2026-11-01 is a Sunday.
	return Array.from({ length: 7 }, (_, index) =>
		formatDateIn(new Date(2026, 10, 1 + first + index), language, { weekday: "short" }),
	);
}

/** "novembre 2026" / "November 2026". */
export function monthTitle(year: number, month: number, language: string | null | undefined): string {
	return formatDateIn(new Date(year, month - 1, 1), language, { month: "long", year: "numeric" });
}

/** The twelve short month names ("janv." … / "Jan" …). */
export function monthNames(language: string | null | undefined): string[] {
	return Array.from({ length: 12 }, (_, index) =>
		formatDateIn(new Date(2026, index, 1), language, { month: "short" }),
	);
}

export interface CalendarCell {
	day: string;
	inMonth: boolean;
}

/** The six weeks a month's calendar shows, starting on the language's first weekday. */
export function calendarCells(year: number, month: number, language: string | null | undefined): CalendarCell[] {
	const first = new Date(year, month - 1, 1);
	const offset = (first.getDay() - weekStart(language) + 7) % 7;
	return Array.from({ length: 42 }, (_, index) => {
		const date = new Date(year, month - 1, 1 - offset + index);
		return { day: dayOf(date), inMonth: date.getMonth() === month - 1 };
	});
}

/** The day `delta` days after a YYYY-MM-DD one (which must be a real day). */
export function shiftDay(value: string, delta: number): string {
	const [year, month, day] = value.split("-").map(Number);
	return dayOf(new Date(year, month - 1, day + delta));
}

/** The year and month `delta` months after the given ones. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
	const date = new Date(year, month - 1 + delta, 1);
	return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

/** Whether a YYYY-MM-DD or YYYY-MM value lies within the optional bounds (same shape). */
export function withinBounds(value: string, min?: string, max?: string): boolean {
	return !(min && value < min) && !(max && value > max);
}

/** The parts of a YYYY-MM value, or null. */
export function parseIsoMonth(value: string | null | undefined): { year: number; month: number } | null {
	const match = ISO_MONTH.exec(value ?? "");
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	return year >= 1000 && month >= 1 && month <= 12 ? { year, month } : null;
}

/** The YYYY-MM of a year and month. */
export function isoMonth(year: number, month: number): string {
	return `${year}-${pad(month)}`;
}

/** A YYYY-MM value written out: "novembre 2026" / "November 2026", or "". */
export function formatMonthField(value: string, language: string | null | undefined): string {
	const parts = parseIsoMonth(value);
	return parts ? monthTitle(parts.year, parts.month, language) : "";
}

/** The hours and minutes of a 24-hour HH:MM value, or null. */
export function parseIsoTime(value: string | null | undefined): { hours: number; minutes: number } | null {
	const match = ISO_TIME.exec(value ?? "");
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	return hours < 24 && minutes < 60 ? { hours, minutes } : null;
}

/** A 24-hour HH:MM value as the field writes it: 14:30 in French, 02:30 PM in English. */
export function formatTimeField(value: string, language: string | null | undefined): string {
	const parts = parseIsoTime(value);
	if (!parts) return "";
	if (isFrench(language)) return `${pad(parts.hours)}:${pad(parts.minutes)}`;
	const hour12 = parts.hours % 12 || 12;
	return `${pad(hour12)}:${pad(parts.minutes)} ${parts.hours < 12 ? "AM" : "PM"}`;
}

/**
 * What a typed time means: "" when empty, the 24-hour HH:MM when it names a
 * time, null otherwise. Takes 14:30, 14h30, 1430, 9, 2:30 pm and 2pm in
 * either language.
 */
export function parseTimeField(text: string): string | null {
	const trimmed = text.trim().toLowerCase();
	if (!trimmed) return "";
	const match = /^(\d{1,2})(?:\s*[:h.]\s*(\d{2})?|(\d{2}))?\s*(am|pm|a|p)?$/.exec(trimmed);
	if (!match) return null;
	let hours = Number(match[1]);
	const minutes = Number(match[2] ?? match[3] ?? 0);
	const meridiem = match[4]?.[0];
	if (meridiem) {
		if (hours < 1 || hours > 12) return null;
		hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
	}
	if (hours > 23 || minutes > 59) return null;
	return `${pad(hours)}:${pad(minutes)}`;
}

/** The times a time field offers in its list: every half hour. */
export function timeSlots(): string[] {
	return Array.from({ length: 48 }, (_, index) => `${pad(Math.floor(index / 2))}:${index % 2 ? "30" : "00"}`);
}
