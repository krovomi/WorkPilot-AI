/**
 * Page activity and the organization's usage settings (server mode).
 *
 * Page activity: while the person's organization turned it on on the server
 * (`GET /users/me/page-activity`, off by default), each view the person
 * opens adds one to today's count of that view, and the counts go to the
 * server in one batch every few minutes (`POST /users/me/page-activity`).
 * Only a name of `PAGE_ACTIVITY_PAGES` is counted: the renderer is not
 * trusted (rule S6), and no project, card or text can enter a count. Nothing
 * is counted in local mode, signed out, or while the organization keeps it
 * off; a sign-out or a change of organization drops what was not sent.
 *
 * Settings: `GET` / `PUT /admin/usage/settings` (`usage.read` /
 * `usage.write`), checked here with the server's bounds before a request
 * leaves.
 */

import {
	isPageActivityPage,
	type PageActivityPage,
} from "../shared/constants/page-activity";
import type {
	UsageResult,
	UsageSettings,
	UsageSettingsUpdate,
} from "../shared/types/server-usage";
import {
	authedFetch,
	getActiveOrgId,
	getAccessToken,
	getAuthState,
	isServerMode,
} from "./server-connection";

/** As the server bounds a retention (`services/usage_settings.py`). */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
/** How often counts are sent, and the state asked again. */
export const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** As the server bounds a batch and a count (`services/page_activity.py`). */
const MAX_VISITS = 200;
const MAX_COUNT = 10_000;
const PAGE_ACTIVITY = "/users/me/page-activity";
const SETTINGS = "/admin/usage/settings";

interface Collecting {
	/** Whose counts these are: the person and the organization they act in. */
	owner: string;
	enabled: boolean | null;
	counts: Map<string, number>;
	asking: Promise<void> | null;
	/** A batch is on its way: another send waits for the next turn. */
	sending: boolean;
}

let state: Collecting | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function ownerNow(): string | null {
	if (!isServerMode() || getAccessToken() === null) return null;
	const user = getAuthState().user;
	return user ? `${user.id}@${getActiveOrgId() ?? ""}` : null;
}

/** The counts of the person signed in now; a new person starts from none. */
function current(): Collecting | null {
	const owner = ownerNow();
	if (owner === null) {
		state = null;
		return null;
	}
	if (state?.owner !== owner) {
		state = { owner, enabled: null, counts: new Map(), asking: null, sending: false };
	}
	return state;
}

function today(now: Date): string {
	return now.toISOString().slice(0, 10);
}

async function askState(collecting: Collecting): Promise<void> {
	const result = await authedFetch<{ enabled?: unknown }>(PAGE_ACTIVITY, "GET");
	if (state !== collecting) return;
	collecting.enabled = result.ok && result.data?.enabled === true;
	if (!collecting.enabled) collecting.counts.clear();
}

function ensureTimer(): void {
	if (timer !== null) return;
	timer = setInterval(() => void flushPageActivity(), FLUSH_INTERVAL_MS);
	timer.unref?.();
}

/**
 * The person opened `page`: count it when the organization has page activity
 * on (asked once per person, then at each send). Whether it was counted.
 */
export async function notePageVisit(page: unknown, now = new Date()): Promise<boolean> {
	if (!isPageActivityPage(page)) return false;
	const collecting = current();
	if (collecting === null) return false;
	ensureTimer();
	if (collecting.enabled === null) {
		collecting.asking ??= askState(collecting);
		await collecting.asking;
	}
	if (!collecting.enabled || state !== collecting) return false;
	const key = `${today(now)}|${page}`;
	if (!collecting.counts.has(key) && collecting.counts.size >= MAX_VISITS) return false;
	collecting.counts.set(key, Math.min((collecting.counts.get(key) ?? 0) + 1, MAX_COUNT));
	return true;
}

/**
 * Send the counts not sent yet, then take what the server says about page
 * activity (turned off: nothing more is counted). Counts that could not be
 * sent are kept for the next time; nothing is sent signed out.
 */
export async function flushPageActivity(): Promise<number> {
	const collecting = current();
	if (collecting === null) return 0;
	if (collecting.counts.size === 0) {
		await askState(collecting);
		return 0;
	}
	if (collecting.sending) return 0;
	collecting.sending = true;
	const sent = new Map(collecting.counts);
	const visits = [...sent].map(([key, count]) => {
		const [day, page] = key.split("|") as [string, PageActivityPage];
		return { day, page, count };
	});
	const result = await authedFetch<{ enabled?: unknown; recorded?: unknown }>(
		PAGE_ACTIVITY,
		"POST",
		{ client: "desktop", visits },
	);
	collecting.sending = false;
	if (!result.ok || state !== collecting) return 0;
	for (const [key, count] of sent) {
		const left = (collecting.counts.get(key) ?? 0) - count;
		if (left > 0) collecting.counts.set(key, left);
		else collecting.counts.delete(key);
	}
	collecting.enabled = result.data?.enabled === true;
	if (!collecting.enabled) collecting.counts.clear();
	return typeof result.data?.recorded === "number" ? result.data.recorded : 0;
}

/** Stop sending (the app quits): what was not sent is dropped. */
export function stopPageActivity(): void {
	if (timer !== null) clearInterval(timer);
	timer = null;
	state = null;
}

function retention(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < MIN_RETENTION_DAYS ||
		value > MAX_RETENTION_DAYS
	) {
		return undefined;
	}
	return value;
}

/** The organization's usage settings (`usage.read`). */
export function getUsageSettings(): Promise<UsageResult<UsageSettings>> {
	return authedFetch<UsageSettings>(SETTINGS, "GET");
}

/** Change them (`usage.write`), checked with the server's bounds first. */
export async function setUsageSettings(
	body: unknown,
): Promise<UsageResult<UsageSettings>> {
	const raw = (body ?? {}) as Record<string, unknown>;
	const usage = retention(raw.usage_retention_days ?? null);
	const pages = retention(raw.page_activity_retention_days ?? null);
	if (typeof raw.page_activity !== "boolean" || usage === undefined || pages === undefined) {
		return { ok: false, error: "Invalid usage settings" };
	}
	const update: UsageSettingsUpdate = {
		page_activity: raw.page_activity,
		usage_retention_days: usage,
		page_activity_retention_days: pages,
	};
	const result = await authedFetch<UsageSettings>(SETTINGS, "PUT", update);
	// This person's own counting follows the change at once.
	if (result.ok && state) {
		state.enabled = null;
		state.asking = null;
	}
	return result;
}
