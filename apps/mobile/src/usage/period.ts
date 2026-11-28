/** A period of the last `days` UTC days, today included, as the server reads it. */
export function periodOf(days: number, now = new Date()): { start: string; end: string } {
	const day = (date: Date) => date.toISOString().slice(0, 10);
	return { start: day(new Date(now.getTime() - (days - 1) * 86_400_000)), end: day(now) };
}
