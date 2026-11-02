import { formatAppDateTime } from "@/lib/date-format";

export function formatDate(timestamp: string): string {
	return formatAppDateTime(timestamp) || timestamp;
}
