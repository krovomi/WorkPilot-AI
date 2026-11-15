/**
 * @vitest-environment node
 *
 * Waiting for a pull request's checks before a review, against a stand-in
 * GitHub and a fake clock: the wait ends when nothing is queued or running,
 * reports what still runs every 20 seconds, gives up after 30 minutes, stops
 * when the person cancels, and never blocks a review on a failed call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PRReviewProgress, performCIWaitCheck, waitForCIChecks } from "../pr-ci-wait";

type Run = { name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null };
const run = (name: string, status: Run["status"]): Run => ({
	name,
	status,
	conclusion: status === "completed" ? "success" : null,
});

const fetchMock = vi.fn();
const progress: PRReviewProgress[] = [];
const sendProgress = (p: PRReviewProgress) => {
	progress.push(p);
};

/** Each poll answers the next list of check runs; the last one repeats. */
function serveChecks(...polls: Run[][]) {
	let poll = 0;
	fetchMock.mockImplementation(async (url: string) => {
		if (url.endsWith("/pulls/5")) {
			return new Response(JSON.stringify({ head: { sha: "abc123" } }), { status: 200 });
		}
		const runs = polls[Math.min(poll++, polls.length - 1)];
		return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs }), { status: 200 });
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	progress.length = 0;
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("waitForCIChecks", () => {
	it("returns at once when every check has completed", async () => {
		serveChecks([run("build", "completed")]);

		const result = await waitForCIChecks("pat-test-0000", "acme/shop", "abc123", 5, sendProgress);

		expect(result).toEqual({
			success: true,
			hasInProgress: false,
			inProgressCount: 0,
			inProgressChecks: [],
			timedOut: false,
			waitTimeSeconds: 0,
		});
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/acme/shop/commits/abc123/check-runs");
		expect(progress).toEqual([]);
	});

	it("waits on queued and running checks, polling every 20 seconds, and names them", async () => {
		serveChecks(
			[run("build", "queued"), run("lint", "in_progress"), run("docs", "completed")],
			[run("build", "in_progress"), run("lint", "completed")],
			[run("build", "completed")],
		);

		const waiting = waitForCIChecks("pat-test-0000", "acme/shop", "abc123", 5, sendProgress);
		await vi.advanceTimersByTimeAsync(40_000);
		const result = await waiting;

		expect(result).toMatchObject({ success: true, timedOut: false, waitTimeSeconds: 40 });
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(progress.map((p) => p.message)).toEqual([
			"Waiting for CI checks to complete (build, lint)... 30m remaining",
			"Waiting for CI checks to complete (build)... 30m remaining",
		]);
		expect(progress[0]).toMatchObject({ phase: "fetching", prNumber: 5, progress: 5 });
	});

	it("shortens a long list of running checks", async () => {
		serveChecks(["a", "b", "c", "d", "e"].map((n) => run(n, "in_progress")), []);

		const waiting = waitForCIChecks("pat-test-0000", "acme/shop", "abc123", 5, sendProgress);
		await vi.advanceTimersByTimeAsync(20_000);
		await waiting;

		expect(progress[0].message).toBe("Waiting for CI checks to complete (a, b, c and 2 more)... 30m remaining");
	});

	it("gives up after 30 minutes and says what was still running", async () => {
		serveChecks([run("e2e", "in_progress")]);

		const waiting = waitForCIChecks("pat-test-0000", "acme/shop", "abc123", 5, sendProgress);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		const result = await waiting;

		expect(result).toEqual({
			success: false,
			hasInProgress: true,
			inProgressCount: 1,
			inProgressChecks: ["e2e"],
			timedOut: true,
			waitTimeSeconds: 1800,
		});
		expect(fetchMock).toHaveBeenCalledTimes(90);
		expect(progress.at(-1)?.message).toContain("1m remaining");
	});

	it("stops when cancelled before a poll and during the wait between two", async () => {
		serveChecks([run("build", "in_progress")]);
		const before = new AbortController();
		before.abort();

		expect(await waitForCIChecks("t", "acme/shop", "abc123", 5, sendProgress, before.signal)).toEqual({
			success: false,
			hasInProgress: false,
			inProgressCount: 0,
			inProgressChecks: [],
			timedOut: false,
			waitTimeSeconds: 0,
		});
		expect(fetchMock).not.toHaveBeenCalled();

		const during = new AbortController();
		const waiting = waitForCIChecks("t", "acme/shop", "abc123", 5, sendProgress, during.signal);
		await vi.advanceTimersByTimeAsync(5_000);
		during.abort();
		await vi.advanceTimersByTimeAsync(15_000);

		expect(await waiting).toEqual({
			success: false,
			hasInProgress: true,
			inProgressCount: 1,
			inProgressChecks: ["build"],
			timedOut: false,
			waitTimeSeconds: 20,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([[new Error("GitHub API error: 403 Forbidden - rate limited")], ["odd"]])(
		"lets the review go on when the checks cannot be read: %s",
		async (thrown) => {
			fetchMock.mockRejectedValue(thrown);

			expect(await waitForCIChecks("t", "acme/shop", "abc123", 5, sendProgress)).toEqual({
				success: true,
				hasInProgress: false,
				inProgressCount: 0,
				inProgressChecks: [],
				timedOut: false,
				waitTimeSeconds: 0,
			});
		},
	);
});

describe("performCIWaitCheck", () => {
	const config = { token: "pat-test-0000", repo: "acme/shop" };

	it("reads the head of the pull request, then waits on its checks", async () => {
		serveChecks([run("build", "completed")]);

		expect(await performCIWaitCheck(config, 5, sendProgress, "review")).toBe(true);

		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
			"https://api.github.com/repos/acme/shop/pulls/5",
			"https://api.github.com/repos/acme/shop/commits/abc123/check-runs",
		]);
		expect(progress[0]).toEqual({ phase: "fetching", prNumber: 5, progress: 5, message: "Checking CI status..." });
	});

	it("goes on after a wait and after a timeout", async () => {
		serveChecks([run("build", "in_progress")], []);
		const waited = performCIWaitCheck(config, 5, sendProgress, "follow-up review");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(await waited).toBe(true);

		serveChecks([run("build", "in_progress")]);
		const timedOut = performCIWaitCheck(config, 5, sendProgress, "review");
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(await timedOut).toBe(true);
	});

	it("stops the review when the person cancels", async () => {
		serveChecks([run("build", "in_progress")]);
		const controller = new AbortController();

		const waiting = performCIWaitCheck(config, 5, sendProgress, "review", controller.signal);
		await vi.advanceTimersByTimeAsync(1_000);
		controller.abort();
		await vi.advanceTimersByTimeAsync(19_000);

		expect(await waiting).toBe(false);
	});

	it.each([[new Error("Not Found")], [404]])(
		"lets the review go on when the pull request cannot be read: %s",
		async (thrown) => {
			fetchMock.mockRejectedValue(thrown);

			expect(await performCIWaitCheck(config, 5, sendProgress, "review")).toBe(true);
		},
	);
});
