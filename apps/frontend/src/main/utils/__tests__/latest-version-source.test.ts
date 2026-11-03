import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLatestVersionSource,
	describeNetworkError,
	fetchJsonWithRetry,
	HttpStatusError,
	npmVersionOf,
} from "../latest-version-source";

/** What `AbortSignal.timeout` rejects with: the error from the bug report. */
function timeoutError(): Error {
	return new DOMException(
		"The operation was aborted due to timeout",
		"TimeoutError",
	);
}

function fetchFailed(code: string): TypeError {
	return new TypeError("fetch failed", { cause: { code } });
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

describe("describeNetworkError", () => {
	it("says a timeout in two words", () => {
		expect(describeNetworkError(timeoutError())).toBe("timed out");
	});

	it("adds the system error code of a failed connection", () => {
		expect(describeNetworkError(fetchFailed("ENOTFOUND"))).toBe(
			"fetch failed (ENOTFOUND)",
		);
	});

	it("keeps the first line of a multi-line message only", () => {
		const error = new Error("Command failed: gh api\nHTTP 401\nmore stderr");
		expect(describeNetworkError(error)).toBe("Command failed: gh api");
	});

	it("handles values that are not errors", () => {
		expect(describeNetworkError("boom")).toBe("boom");
	});
});

describe("npmVersionOf", () => {
	it("reads the version of a registry document", () => {
		expect(npmVersionOf({ version: "1.2.3" })).toBe("1.2.3");
	});

	it("refuses a document without a version", () => {
		expect(() => npmVersionOf({})).toThrow(TypeError);
		expect(() => npmVersionOf(null)).toThrow(TypeError);
	});
});

describe("createLatestVersionSource", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function source(load: () => Promise<string>, failureBackoffMs?: number) {
		return createLatestVersionSource({
			label: "[Codex CLI]",
			what: "the latest version on npm",
			ttlMs: 60_000,
			failureBackoffMs,
			load,
		});
	}

	it("keeps a good answer for its TTL", async () => {
		const load = vi.fn().mockResolvedValue("1.0.0");
		const latest = source(load);

		expect(await latest.get()).toBe("1.0.0");
		vi.advanceTimersByTime(59_000);
		expect(await latest.get()).toBe("1.0.0");
		expect(load).toHaveBeenCalledTimes(1);

		load.mockResolvedValue("1.1.0");
		vi.advanceTimersByTime(2_000);
		expect(await latest.get()).toBe("1.1.0");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("logs a timeout as one short line, without the error object", async () => {
		const latest = source(() => Promise.reject(timeoutError()));

		expect(await latest.get()).toBeUndefined();

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]).toEqual([
			"[Codex CLI] Could not check the latest version on npm (timed out); next try in 5 min.",
		]);
		expect(latest.lastFailure()).toBe("timed out");
	});

	it("does not ask again, nor log, until the backoff ends", async () => {
		const load = vi.fn().mockRejectedValue(timeoutError());
		const latest = source(load);

		await latest.get();
		vi.advanceTimersByTime(4 * 60_000);
		await latest.get();
		await latest.get();
		expect(load).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);

		load.mockResolvedValue("2.0.0");
		vi.advanceTimersByTime(60_001);
		expect(await latest.get()).toBe("2.0.0");
		expect(latest.lastFailure()).toBeUndefined();
	});

	it("answers with the last known version when a refresh fails", async () => {
		const load = vi.fn().mockResolvedValue("1.0.0");
		const latest = source(load);
		await latest.get();

		load.mockRejectedValue(fetchFailed("ECONNRESET"));
		vi.advanceTimersByTime(61_000);
		expect(await latest.get()).toBe("1.0.0");
		expect(latest.peek()).toBe("1.0.0");
	});

	it("retries on the next call when there is no backoff", async () => {
		const load = vi.fn().mockRejectedValue(timeoutError());
		const latest = source(load, 0);

		await latest.get();
		await latest.get();
		expect(load).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[0]?.[0]).toBe(
			"[Codex CLI] Could not check the latest version on npm (timed out).",
		);
	});

	it("forgets value and failure on invalidate", async () => {
		const load = vi.fn().mockRejectedValue(timeoutError());
		const latest = source(load);
		await latest.get();

		latest.invalidate();
		load.mockResolvedValue("3.0.0");
		expect(await latest.get()).toBe("3.0.0");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("shares one lookup between concurrent callers", async () => {
		let resolve: (v: string) => void = () => undefined;
		const load = vi.fn(
			() =>
				new Promise<string>((r) => {
					resolve = r;
				}),
		);
		const latest = source(load);

		const both = Promise.all([latest.get(), latest.get()]);
		resolve("4.0.0");
		expect(await both).toEqual(["4.0.0", "4.0.0"]);
		expect(load).toHaveBeenCalledTimes(1);
	});
});

describe("fetchJsonWithRetry", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	async function run(): Promise<unknown> {
		const result = fetchJsonWithRetry("https://registry.example/pkg", {});
		// Swallow here, assert in the test, while the retry delay elapses.
		result.catch(() => undefined);
		await vi.runAllTimersAsync();
		return result;
	}

	it("sends Accept and a timeout signal", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ version: "1.0.0" }));
		await expect(run()).resolves.toEqual({ version: "1.0.0" });
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.headers).toMatchObject({ Accept: "application/json" });
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("retries once when the connection drops", async () => {
		fetchMock
			.mockRejectedValueOnce(fetchFailed("ECONNRESET"))
			.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }));
		await expect(run()).resolves.toEqual({ version: "1.0.0" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries once on a server error", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({}, 503))
			.mockResolvedValueOnce(jsonResponse({}, 503));
		await expect(run()).rejects.toBeInstanceOf(HttpStatusError);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a timeout, which would double the wait", async () => {
		fetchMock.mockRejectedValue(timeoutError());
		await expect(run()).rejects.toThrow("timeout");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry a client error", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 404));
		await expect(run()).rejects.toThrow("HTTP 404");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
