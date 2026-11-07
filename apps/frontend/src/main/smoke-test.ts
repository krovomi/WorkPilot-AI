/**
 * Start-up smoke test: with WORKPILOT_SMOKE_TEST=1 the app quits on its own,
 * 0 once the renderer has mounted its root, 1 if the renderer fails first.
 *
 * `scripts/smoke-test.cjs` runs the built app (CI) or the packaged one
 * (release) with it. A main process that throws while loading never reaches
 * this code and never prints the marker, which is the 1.3.1 crash (F114): the
 * script reads that as a failure too.
 *
 * A pass quits the way a user does (`app.quit()`): `before-quit` and
 * `will-quit` stop the agents, terminals, backend and the Python bootstrap.
 * `app.exit()` skipped them and left the main process tearing down while the
 * startup work still ran; the DevTools a built app opens docked could then
 * attach to the closing window, a Chromium CHECK, SIGILL (F134). The smoke
 * test no longer opens the DevTools either (index.ts).
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";

export const SMOKE_TEST_ENV = "WORKPILOT_SMOKE_TEST";
export const SMOKE_OK_MARKER = "WORKPILOT_SMOKE_OK";
export const SMOKE_FAIL_MARKER = "WORKPILOT_SMOKE_FAIL";

/** How long the renderer has to mount `#root` once its page has loaded. */
const MOUNT_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export function isSmokeTest(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SMOKE_TEST_ENV] === "1";
}

/** Script run in the page: how many children React gave `#root`. */
export const ROOT_CHILDREN_PROBE =
	"document.getElementById('root')?.childElementCount ?? 0";

/**
 * Wait until the renderer's `#root` has children, or the timeout passes.
 * `probe` runs the script in the page; injected so the wait is testable.
 */
export async function waitForMountedRoot(
	probe: () => Promise<unknown>,
	timeoutMs: number = MOUNT_TIMEOUT_MS,
	pollMs: number = POLL_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const children = Number(await probe().catch(() => 0));
		if (children > 0) return true;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	return false;
}

function finish(ok: boolean, reason: string): void {
	// Plain stdout/stderr: the script reads the marker from the process output.
	// Quit once the line is flushed: a pipe is asynchronous on Windows, and
	// quitting first would drop the marker. A failure still exits at once,
	// with code 1: `app.quit()` always ends with 0.
	const exit = () => (ok ? app.quit() : app.exit(1));
	if (ok) {
		process.stdout.write(`${SMOKE_OK_MARKER} ${reason}\n`, exit);
	} else {
		process.stderr.write(`${SMOKE_FAIL_MARKER} ${reason}\n`, exit);
	}
}

/** Arm the smoke test on the main window. Does nothing without the env var. */
export function armSmokeTest(window: BrowserWindow): void {
	if (!isSmokeTest()) return;
	const contents = window.webContents;

	contents.once("did-fail-load", (_event, code, description) => {
		finish(false, `renderer failed to load (${code} ${description})`);
	});
	contents.once("render-process-gone", (_event, details) => {
		finish(false, `renderer process gone (${details.reason})`);
	});
	contents.once("did-finish-load", () => {
		void waitForMountedRoot(() =>
			contents.executeJavaScript(ROOT_CHILDREN_PROBE),
		).then((mounted) =>
			finish(
				mounted,
				mounted
					? `renderer mounted (version ${app.getVersion()})`
					: "renderer loaded but #root stayed empty",
			),
		);
	});
}
