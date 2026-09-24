/**
 * ChatGPT subscription limits (Codex CLI login) — the 5-hour and weekly windows.
 *
 * An OpenAI account signed in through `codex login` is billed against the
 * ChatGPT plan, not against API credits: what runs out is a 5-hour window and
 * a weekly window, exactly like a Claude Code subscription. The usage monitor
 * only knew the API-key half of OpenAI (a monthly cost the `/v1/organization`
 * endpoint refuses to ordinary keys), so a ChatGPT-backed provider showed an
 * empty "$" instead of the two percentages that actually gate a build.
 *
 * Two sources, the same ones Codex CLI itself reads:
 *
 * | Source | What it is |
 * |---|---|
 * | `GET https://chatgpt.com/backend-api/wham/usage` | what `codex /status` asks — live, with the token Codex keeps in `auth.json` |
 * | `$CODEX_HOME/sessions/**\/rollout-*.jsonl` | the `rate_limits` Codex records on every `token_count` event — offline, as of the last turn |
 *
 * The token is only read, never refreshed: `auth.json` belongs to Codex CLI,
 * which rotates it on its next run. An expired token falls back to the log.
 */

import { existsSync, promises as fsp } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { UsageSnapshot } from "@shared/types";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** One rate-limit window, as both sources describe it once normalised. */
export interface CodexRateLimitWindow {
	/** 0-100 */
	usedPercent: number;
	/** Window length in minutes (300 = 5 hours, 10080 = 7 days) */
	windowMinutes?: number;
	/** When the window resets, ISO 8601 */
	resetsAt?: string;
}

export interface CodexRateLimits {
	primary?: CodexRateLimitWindow;
	secondary?: CodexRateLimitWindow;
	planType?: string;
	source: "chatgpt-usage-api" | "codex-session-log";
	/** When the numbers were true — now for the API, the log line's time otherwise */
	observedAt: string;
}

export interface CodexAuth {
	accessToken: string;
	accountId?: string;
}

export function resolveCodexHome(): string {
	const fromEnv = process.env.CODEX_HOME?.trim();
	return fromEnv ? fromEnv : path.join(homedir(), ".codex");
}

/**
 * The ChatGPT token Codex CLI stored after `codex login`, or null when Codex
 * is signed in with an API key (or not at all).
 */
export async function readCodexAuth(
	codexHome: string = resolveCodexHome(),
): Promise<CodexAuth | null> {
	try {
		const raw = await fsp.readFile(path.join(codexHome, "auth.json"), "utf-8");
		const data = JSON.parse(raw) as {
			auth_mode?: string;
			tokens?: { access_token?: string; account_id?: string } | null;
		};
		if (data.auth_mode && data.auth_mode.toLowerCase() === "apikey") {
			return null;
		}
		const accessToken = data.tokens?.access_token;
		if (typeof accessToken !== "string" || !accessToken) return null;
		return {
			accessToken,
			accountId:
				typeof data.tokens?.account_id === "string"
					? data.tokens.account_id
					: undefined,
		};
	} catch {
		return null;
	}
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function epochToIso(value: unknown): string | undefined {
	const n = finiteNumber(value);
	if (n === undefined || n <= 0) return undefined;
	// Seconds since epoch; tolerate milliseconds.
	const ms = n > 1e12 ? n : n * 1000;
	return new Date(ms).toISOString();
}

function clampPercent(value: number): number {
	return Math.min(Math.max(value, 0), 100);
}

/** `rate_limit.primary_window` / `secondary_window` of the usage API. */
function parseApiWindow(
	raw: unknown,
	now: number,
): CodexRateLimitWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const w = raw as Record<string, unknown>;
	const used = finiteNumber(w.used_percent);
	if (used === undefined) return undefined;
	const seconds = finiteNumber(w.limit_window_seconds);
	let resetsAt = epochToIso(w.reset_at);
	if (!resetsAt) {
		const after = finiteNumber(w.reset_after_seconds);
		if (after !== undefined) resetsAt = new Date(now + after * 1000).toISOString();
	}
	return {
		usedPercent: clampPercent(used),
		windowMinutes: seconds !== undefined ? Math.round(seconds / 60) : undefined,
		resetsAt,
	};
}

/** Parse the JSON body of `GET /backend-api/wham/usage`. */
export function parseChatGPTUsageResponse(
	body: unknown,
	now: number = Date.now(),
): CodexRateLimits | null {
	if (!body || typeof body !== "object") return null;
	const data = body as Record<string, unknown>;
	const rateLimit = (data.rate_limit ?? null) as Record<string, unknown> | null;
	const primary = parseApiWindow(rateLimit?.primary_window, now);
	const secondary = parseApiWindow(rateLimit?.secondary_window, now);
	if (!primary && !secondary) return null;
	return {
		primary,
		secondary,
		planType: typeof data.plan_type === "string" ? data.plan_type : undefined,
		source: "chatgpt-usage-api",
		observedAt: new Date(now).toISOString(),
	};
}

/** `rate_limits.primary` / `secondary` of a Codex `token_count` event. */
function parseLogWindow(
	raw: unknown,
	observedAtMs: number,
	now: number,
): CodexRateLimitWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const w = raw as Record<string, unknown>;
	const used = finiteNumber(w.used_percent);
	if (used === undefined) return undefined;
	const windowMinutes = finiteNumber(w.window_minutes);
	let resetsAt = epochToIso(w.resets_at);
	if (!resetsAt) {
		const inSeconds = finiteNumber(w.resets_in_seconds);
		if (inSeconds !== undefined) {
			resetsAt = new Date(observedAtMs + inSeconds * 1000).toISOString();
		}
	}
	// The log is a picture of the last turn. A window that has reset since
	// then is known to be empty — reporting the old figure would be wrong.
	const expired = resetsAt !== undefined && Date.parse(resetsAt) <= now;
	return {
		usedPercent: expired ? 0 : clampPercent(used),
		windowMinutes,
		resetsAt: expired ? undefined : resetsAt,
	};
}

/**
 * The last `rate_limits` of a rollout file's content, or null. Lines are read
 * from the end: the newest event is the only one that matters.
 */
export function parseRateLimitsFromRollout(
	content: string,
	now: number = Date.now(),
): CodexRateLimits | null {
	const lines = content.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.includes("rate_limits")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const payload = (entry.payload ?? entry.msg ?? entry) as Record<
			string,
			unknown
		>;
		const rateLimits = payload?.rate_limits as
			| Record<string, unknown>
			| null
			| undefined;
		if (!rateLimits || typeof rateLimits !== "object") continue;
		const ts =
			typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		const observedAtMs = Number.isFinite(ts) ? ts : now;
		const primary = parseLogWindow(rateLimits.primary, observedAtMs, now);
		const secondary = parseLogWindow(rateLimits.secondary, observedAtMs, now);
		if (!primary && !secondary) continue;
		return {
			primary,
			secondary,
			planType:
				typeof rateLimits.plan_type === "string"
					? rateLimits.plan_type
					: undefined,
			source: "codex-session-log",
			observedAt: new Date(observedAtMs).toISOString(),
		};
	}
	return null;
}

/** Newest-first entries of a directory whose names sort chronologically. */
async function sortedEntries(dir: string): Promise<string[]> {
	try {
		const names = await fsp.readdir(dir);
		return names.sort().reverse();
	} catch {
		return [];
	}
}

/**
 * Rate limits from the newest Codex session logs. Sessions are stored as
 * `sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`, so walking the
 * directories in reverse name order visits the newest files first; only a
 * handful are read.
 */
export async function readRateLimitsFromSessions(
	codexHome: string = resolveCodexHome(),
	now: number = Date.now(),
	maxFiles = 8,
): Promise<CodexRateLimits | null> {
	const sessionsDir = path.join(codexHome, "sessions");
	if (!existsSync(sessionsDir)) return null;

	let examined = 0;
	for (const year of await sortedEntries(sessionsDir)) {
		const yearDir = path.join(sessionsDir, year);
		for (const month of await sortedEntries(yearDir)) {
			const monthDir = path.join(yearDir, month);
			for (const day of await sortedEntries(monthDir)) {
				const dayDir = path.join(monthDir, day);
				const files = (await sortedEntries(dayDir)).filter((f) =>
					f.endsWith(".jsonl"),
				);
				// Several sessions can run the same day: newest modification wins.
				const withTimes = await Promise.all(
					files.map(async (f) => {
						try {
							const stat = await fsp.stat(path.join(dayDir, f));
							return { f, mtime: stat.mtimeMs };
						} catch {
							return { f, mtime: 0 };
						}
					}),
				);
				withTimes.sort((a, b) => b.mtime - a.mtime);
				for (const { f } of withTimes) {
					if (examined >= maxFiles) return null;
					examined++;
					try {
						const content = await fsp.readFile(path.join(dayDir, f), "utf-8");
						const limits = parseRateLimitsFromRollout(content, now);
						if (limits) return limits;
					} catch {
						// unreadable file — try the next one
					}
				}
			}
		}
	}
	return null;
}

export interface FetchCodexRateLimitsOptions {
	codexHome?: string;
	fetchImpl?: typeof fetch;
	now?: number;
	timeoutMs?: number;
}

/**
 * The ChatGPT plan's rate limits: the live API first, the session log when
 * the API cannot answer (expired token, offline, endpoint changed). Null when
 * Codex CLI is not signed in with ChatGPT and has never recorded a limit.
 */
export async function fetchCodexRateLimits(
	options: FetchCodexRateLimitsOptions = {},
): Promise<CodexRateLimits | null> {
	const codexHome = options.codexHome ?? resolveCodexHome();
	const doFetch = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now();

	const auth = await readCodexAuth(codexHome);
	if (auth) {
		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${auth.accessToken}`,
				Accept: "application/json",
				"User-Agent": "codex_cli_rs",
			};
			if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
			const resp = await doFetch(CHATGPT_USAGE_URL, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
			});
			if (resp.ok) {
				const parsed = parseChatGPTUsageResponse(await resp.json(), now);
				if (parsed) return parsed;
			}
		} catch {
			// network error / timeout — fall back to the log
		}
	}

	return readRateLimitsFromSessions(codexHome, now);
}

/**
 * Split the two windows into the session (shorter) and weekly (longer) slots
 * the UI has. Codex calls them primary and secondary, and today primary is
 * 5 hours and secondary a week — but the lengths are in the data, so they
 * decide rather than the names.
 */
export function splitSessionWeekly(limits: CodexRateLimits): {
	session?: CodexRateLimitWindow;
	weekly?: CodexRateLimitWindow;
} {
	const windows = [limits.primary, limits.secondary].filter(
		(w): w is CodexRateLimitWindow => !!w,
	);
	if (windows.length === 2) {
		const [a, b] = windows;
		if (
			a.windowMinutes !== undefined &&
			b.windowMinutes !== undefined &&
			a.windowMinutes > b.windowMinutes
		) {
			return { session: b, weekly: a };
		}
		return { session: a, weekly: b };
	}
	const only = windows[0];
	if (!only) return {};
	// A single window longer than a day is the weekly one.
	if (only.windowMinutes !== undefined && only.windowMinutes > 24 * 60) {
		return { weekly: only };
	}
	return { session: only };
}

/** i18n key for a window length. */
export function windowLabelKey(
	windowMinutes: number | undefined,
	fallback: string,
): string {
	if (windowMinutes === 300) return "common:usage.window5Hour";
	if (windowMinutes === 10080) return "common:usage.window7Day";
	return fallback;
}

/**
 * The snapshot the usage indicator renders. A window the plan does not report
 * is -1, the "N/A" convention the indicator already uses for a Claude Pro plan
 * with no weekly bucket — never 0, which would read as "nothing used".
 */
export function codexLimitsToSnapshot(
	limits: CodexRateLimits,
	profile: { profileId: string; profileName: string; profileEmail?: string },
): UsageSnapshot {
	const { session, weekly } = splitSessionWeekly(limits);
	const sessionPercent = session ? session.usedPercent : -1;
	const weeklyPercent = weekly ? weekly.usedPercent : -1;
	return {
		sessionPercent: Math.max(sessionPercent, 0),
		weeklyPercent,
		sessionResetTimestamp: session?.resetsAt,
		weeklyResetTimestamp: weekly?.resetsAt,
		profileId: profile.profileId,
		profileName: profile.profileName,
		profileEmail: profile.profileEmail,
		fetchedAt: new Date(),
		limitType: weeklyPercent > sessionPercent ? "weekly" : "session",
		usageWindows: {
			sessionWindowLabel: windowLabelKey(
				session?.windowMinutes,
				"common:usage.sessionDefault",
			),
			weeklyWindowLabel: windowLabelKey(
				weekly?.windowMinutes,
				"common:usage.weeklyDefault",
			),
		},
		providerName: "openai",
		openaiSubscription: {
			planType: limits.planType,
			source: limits.source,
			observedAt: limits.observedAt,
		},
	};
}
