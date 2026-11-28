/** How an audit line reads on the phone. */

import { type AuditEntry, LOGIN_METHODS } from "./types";

/** The most details shown for a line, and the longest value. */
export const MAX_DETAILS = 12;
export const MAX_DETAIL_LENGTH = 200;

/** A line's details as label and text, in the server's order, bounded. */
export function auditDetails(payload: AuditEntry["payload"]): { key: string; value: string }[] {
	if (!payload || typeof payload !== "object") return [];
	return Object.entries(payload)
		.slice(0, MAX_DETAILS)
		.map(([key, raw]) => {
			const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw);
			return {
				key,
				value: text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text,
			};
		});
}

/** A sign-in method as a known key, "unknown" for anything else. */
export function loginMethodKey(method: string | null | undefined): string {
	return (LOGIN_METHODS as readonly string[]).includes(method ?? "") ? (method as string) : "unknown";
}
