import { formatAppDate } from "@/lib/date-format";

/**
 * A PR date with its time, in the app's language (fr-FR or en-US).
 * @param dateString - ISO date string to format
 * @returns Formatted date string or empty string if invalid
 */
export function formatDate(dateString: string): string {
	const date = new Date(dateString);
	if (Number.isNaN(date.getTime())) return "";
	return formatAppDate(date, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
