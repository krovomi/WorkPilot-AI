/**
 * The Usage tab's figures and a person's own usage (server mode).
 *
 * Reads `/admin/usage/*` (or `/admin/platform/usage/*` for the whole
 * deployment), `/users/me/usage*` and the notice of what is measured, and
 * erases an account (`POST /admin/users/{id}/erase`). The renderer is not
 * trusted (rule S6): it names a view from a closed list, a period of
 * `YYYY-MM-DD` days and filters checked against the server's own patterns,
 * and nothing else reaches the URL. The server checks the permission again.
 */

import type {
	MyUsage,
	UsageExport,
	UsageNotice,
	UsagePersonSheet,
	UsageQuery,
	UsageResult,
	UsageView,
} from "../shared/types/server-usage";
import { authedFetch } from "./server-connection";

export const USAGE_VIEWS: readonly UsageView[] = [
	"summary",
	"daily",
	"people",
	"models",
	"projects",
	"pages",
	"delivery",
	"presence",
];
export const USAGE_EXPORTS: readonly UsageExport[] = [
	"daily",
	"people",
	"models",
	"phases",
	"projects",
	"pages",
	"failures",
];

/** As the server checks them (`server/routers/usage_admin.py`). */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9-]{1,36}$/;
const NAME = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const FILTERS: ReadonlyArray<[keyof UsageQuery, RegExp]> = [
	["start", DAY],
	["end", DAY],
	["user_id", ID],
	["group_id", ID],
	["project_id", ID],
	["provider", NAME],
	["model", NAME],
];
const INVALID = { ok: false, error: "Invalid usage query" } as const;

interface Asked {
	prefix: string;
	search: string;
}

/** The URL prefix and query string, or null when anything is off. */
export function askedOf(raw: unknown): Asked | null {
	const query = (raw ?? {}) as Record<string, unknown>;
	if (typeof query !== "object" || Array.isArray(query)) return null;
	const params = new URLSearchParams();
	for (const [key, pattern] of FILTERS) {
		const value = query[key];
		if (value === undefined || value === null || value === "") continue;
		if (typeof value !== "string" || !pattern.test(value)) return null;
		params.set(key, value);
	}
	if (query.platform !== undefined && typeof query.platform !== "boolean") return null;
	const search = params.toString();
	return {
		prefix: query.platform === true ? "/admin/platform/usage" : "/admin/usage",
		search: search ? `?${search}` : "",
	};
}

/** One view of the Usage tab. */
export function getUsageView<T>(view: unknown, query: unknown): Promise<UsageResult<T>> {
	const asked = askedOf(query);
	if (!asked || !USAGE_VIEWS.includes(view as UsageView)) return Promise.resolve(INVALID);
	return authedFetch<T>(`${asked.prefix}/${view as string}${asked.search}`, "GET");
}

/** One person's sheet. */
export function getUsagePerson(
	personId: unknown,
	query: unknown,
): Promise<UsageResult<UsagePersonSheet>> {
	const asked = askedOf(query);
	if (!asked || typeof personId !== "string" || !ID.test(personId)) {
		return Promise.resolve(INVALID);
	}
	return authedFetch<UsagePersonSheet>(
		`${asked.prefix}/people/${personId}${asked.search}`,
		"GET",
	);
}

/** One table as CSV text (the server records the export). */
export function exportUsage(view: unknown, query: unknown): Promise<UsageResult<string>> {
	const asked = askedOf(query);
	if (!asked || !USAGE_EXPORTS.includes(view as UsageExport)) return Promise.resolve(INVALID);
	const search = asked.search ? `${asked.search}&view=${view}` : `?view=${view}`;
	return authedFetch<string>(`${asked.prefix}/export${search}`, "GET", undefined, "text");
}

/** What administrators see of the signed-in person, for a period. */
export function getMyUsage(query: unknown): Promise<UsageResult<MyUsage>> {
	const asked = askedOf(query);
	if (!asked) return Promise.resolve(INVALID);
	return authedFetch<MyUsage>(`/users/me/usage${asked.search}`, "GET");
}

/** Everything kept about the person's usage, as JSON text to save. */
export function exportMyUsage(): Promise<UsageResult<string>> {
	return authedFetch<string>("/users/me/usage/export", "GET", undefined, "text");
}

export function getUsageNotice(): Promise<UsageResult<UsageNotice>> {
	return authedFetch<UsageNotice>("/users/me/usage-notice", "GET");
}

/** The person read the notice; the server records it. */
export function markUsageNoticeSeen(): Promise<UsageResult<UsageNotice>> {
	return authedFetch<UsageNotice>("/users/me/usage-notice", "POST");
}

/** Erase an account (platform administrators), its address typed back. */
export function eraseAccount(
	userId: unknown,
	confirmEmail: unknown,
): Promise<UsageResult<{ erased: boolean }>> {
	if (
		typeof userId !== "string" ||
		!ID.test(userId) ||
		typeof confirmEmail !== "string" ||
		confirmEmail.trim().length < 3 ||
		confirmEmail.length > 320
	) {
		return Promise.resolve({ ok: false, error: "Invalid erase request" });
	}
	return authedFetch<{ erased: boolean }>(`/admin/users/${userId}/erase`, "POST", {
		confirm_email: confirmEmail,
	});
}
