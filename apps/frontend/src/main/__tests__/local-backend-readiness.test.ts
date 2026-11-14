import { afterEach, describe, expect, it, vi } from "vitest";
import {
	localBackendLaunchState,
	markLocalBackendFailed,
	markLocalBackendReady,
	markLocalBackendStarting,
	resetLocalBackendReadinessForTests,
	waitForLocalBackend,
} from "../local-backend-readiness";

afterEach(() => {
	vi.useRealTimers();
	resetLocalBackendReadinessForTests();
});

describe("waiting for the local backend main starts", () => {
	it("does not wait when main never said it was starting one", async () => {
		expect(localBackendLaunchState()).toBe("idle");
		expect(await waitForLocalBackend()).toBe(false);
	});

	it("wakes every waiter when the backend answers", async () => {
		markLocalBackendStarting();
		const first = waitForLocalBackend();
		const second = waitForLocalBackend();
		markLocalBackendReady();
		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(await waitForLocalBackend()).toBe(true);
	});

	it("answers false when the launch fails", async () => {
		markLocalBackendStarting();
		const waiting = waitForLocalBackend();
		markLocalBackendFailed();
		expect(await waiting).toBe(false);
	});

	it("stops waiting after its bound", async () => {
		vi.useFakeTimers();
		markLocalBackendStarting();
		const waiting = waitForLocalBackend(1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await waiting).toBe(false);
		expect(localBackendLaunchState()).toBe("pending");
	});

	it("keeps a settled launch when told again it is starting", () => {
		markLocalBackendStarting();
		markLocalBackendReady();
		markLocalBackendStarting();
		expect(localBackendLaunchState()).toBe("ready");
	});
});
