/**
 * Latest-version lookups of the CLI tools (npm registry, GitHub releases).
 *
 * The network is allowed to fail: offline laptop, proxy, slow registry. A
 * failed lookup must not print a stack trace each time a status card asks, so
 * a source:
 * - keeps a good answer for `ttlMs`;
 * - after a failure, answers with the last known version (or `undefined`)
 *   without touching the network for `failureBackoffMs`, and logs one short
 *   line for that failure, never the error object;
 * - shares one lookup between concurrent callers.
 *
 * `get()` never throws: "unknown" is the caller's display decision.
 */

import { coalesceInFlight } from "./coalesce-in-flight";

/** A registry answer this slow is a failure: the check is not worth a wait. */
export const LATEST_VERSION_TIMEOUT_MS = 10_000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 500;
const MAX_REASON_LENGTH = 160;

export class HttpStatusError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
		this.name = "HttpStatusError";
	}
}

function errorCode(error: Error): string | undefined {
	const cause = (error as { cause?: unknown }).cause;
	if (cause && typeof cause === "object" && "code" in cause) {
		return String((cause as { code: unknown }).code);
	}
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/** One short reason for a log line: no stack, no multi-line stderr. */
export function describeNetworkError(error: unknown): string {
	if (!(error instanceof Error)) return String(error).slice(0, MAX_REASON_LENGTH);
	if (error.name === "TimeoutError") return "timed out";
	if (error.name === "AbortError") return "aborted";
	const code = errorCode(error);
	const message = (error.message.split("\n")[0] ?? "").trim();
	const reason = code && !message.includes(code) ? `${message} (${code})` : message;
	return (reason || error.name).slice(0, MAX_REASON_LENGTH);
}

/**
 * Worth one more try: the connection dropped or the server stumbled. A
 * timeout is not (a second one would double the wait), nor a 4xx or a bad
 * payload (the answer would be the same).
 */
function isTransient(error: unknown): boolean {
	if (error instanceof HttpStatusError) {
		return error.status === 429 || error.status >= 500;
	}
	// undici reports a refused, reset or unresolved connection as
	// `TypeError: fetch failed`, with the system error as its cause.
	return error instanceof TypeError && error.message === "fetch failed";
}

/** GET a JSON document, retrying once on a transient failure. */
export async function fetchJsonWithRetry(
	url: string,
	headers: Record<string, string>,
	timeoutMs: number = LATEST_VERSION_TIMEOUT_MS,
): Promise<unknown> {
	const attempt = async (): Promise<unknown> => {
		const response = await fetch(url, {
			headers: { Accept: "application/json", ...headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new HttpStatusError(response.status);
		return response.json();
	};
	try {
		return await attempt();
	} catch (error) {
		if (!isTransient(error)) throw error;
		await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		return attempt();
	}
}

export interface LatestVersionSource<T> {
	/** The fresh value, else the last known one, else `undefined`. Never throws. */
	get(): Promise<T | undefined>;
	/** The value held now, fresh or stale, without any lookup. */
	peek(): T | undefined;
	/** Forget the value and any failure (after an install, or a newer local binary). */
	invalidate(): void;
	/** Why the last lookup failed, while no lookup has succeeded since. */
	lastFailure(): string | undefined;
}

export function createLatestVersionSource<T>(options: {
	/** Log prefix, e.g. `[Codex CLI]`. */
	label: string;
	/** What is looked up, for the log line, e.g. `the latest version`. */
	what: string;
	ttlMs: number;
	/** 0 retries on the next call: for a lookup the person asked for. */
	failureBackoffMs?: number;
	load: () => Promise<T>;
}): LatestVersionSource<T> {
	const backoffMs = options.failureBackoffMs ?? FAILURE_BACKOFF_MS;
	let value: { data: T; at: number } | null = null;
	let failure: { reason: string; at: number } | null = null;

	const lookup = coalesceInFlight(async (): Promise<T | undefined> => {
		try {
			const data = await options.load();
			value = { data, at: Date.now() };
			failure = null;
			return data;
		} catch (error) {
			const reason = describeNetworkError(error);
			failure = { reason, at: Date.now() };
			const retry =
				backoffMs > 0
					? `; next try in ${Math.round(backoffMs / 60_000)} min`
					: "";
			console.warn(
				`${options.label} Could not check ${options.what} (${reason})${retry}.`,
			);
			return value?.data;
		}
	});

	return {
		get() {
			const now = Date.now();
			if (value && now - value.at < options.ttlMs) {
				return Promise.resolve(value.data);
			}
			if (failure && now - failure.at < backoffMs) {
				return Promise.resolve(value?.data);
			}
			return lookup();
		},
		peek: () => value?.data,
		invalidate() {
			value = null;
			failure = null;
		},
		lastFailure: () => failure?.reason,
	};
}

/** `version` of an npm registry document, or a TypeError. */
export function npmVersionOf(data: unknown): string {
	const version = (data as { version?: unknown } | null)?.version;
	if (typeof version !== "string" || !version) {
		throw new TypeError("no version in the npm registry answer");
	}
	return version;
}
