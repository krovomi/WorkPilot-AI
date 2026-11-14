/**
 * Whether the local backend this app starts (FastAPI, 127.0.0.1:9000) is up yet.
 *
 * The window opens before the backend: main launches it once the Python
 * environment is ready and the profile manager has loaded, and a cold start
 * (first launch after an update recompiles the backend) takes tens of seconds.
 * A view that asks the backend at mount — the Hermes badge in the sidebar, the
 * slash commands, the model catalog — got "Failed to fetch" for a backend that
 * was only starting, and kept that red error until someone refreshed it.
 *
 * Main records here when the launch settles; a request that finds nothing
 * listening while the launch is still pending waits for it (bounded), then
 * tries once more. A backend that failed to start, or one that stopped after
 * starting, is reported unreachable at once: waiting would not bring it back.
 */

/**
 * `idle`: main has not said it is starting one (tests, or a backend someone
 * else runs), so nothing waits. `pending` from `markLocalBackendStarting` to
 * the launch's outcome.
 */
type LaunchState = "idle" | "pending" | "ready" | "failed";

let state: LaunchState = "idle";
let waiters: Array<() => void> = [];

/** How long a request waits for a backend that is still starting. */
export const STARTUP_WAIT_MS = 60_000;

function settle(next: LaunchState): void {
	state = next;
	const pending = waiters;
	waiters = [];
	for (const wake of pending) wake();
}

/** Main is about to start the backend: requests that find nothing wait for it. */
export function markLocalBackendStarting(): void {
	if (state === "idle") state = "pending";
}

/** The backend answered: requests stop waiting. */
export function markLocalBackendReady(): void {
	settle("ready");
}

/** The launch gave up: requests stop waiting and report the backend unreachable. */
export function markLocalBackendFailed(): void {
	settle("failed");
}

export function localBackendLaunchState(): LaunchState {
	return state;
}

/**
 * Resolves true once the backend is up, false when its launch failed or
 * `timeoutMs` passed first. Answers at once when the launch has settled.
 */
export function waitForLocalBackend(timeoutMs = STARTUP_WAIT_MS): Promise<boolean> {
	if (state !== "pending") return Promise.resolve(state === "ready");
	return new Promise<boolean>((resolve) => {
		const wake = () => {
			clearTimeout(timer);
			resolve(state === "ready");
		};
		const timer = setTimeout(() => {
			waiters = waiters.filter((w) => w !== wake);
			resolve(false);
		}, timeoutMs);
		waiters.push(wake);
	});
}

/** Tests only: back to before main said anything. */
export function resetLocalBackendReadinessForTests(): void {
	state = "idle";
	waiters = [];
}
