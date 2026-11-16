import { type App, app, type BrowserWindow } from "electron";
import { isSmokeTest } from "./smoke-test";

/** Chromium's net::ERR_ABORTED: another navigation replaced this one. */
const ERR_ABORTED = -3;

type Log = Pick<Console, "warn" | "error">;

export interface WindowRecoveryOptions {
	/** Recoveries allowed inside `windowMs`; past it the window is left alone. */
	maxAttempts?: number;
	windowMs?: number;
	/** Wait before reloading, so a dev server or a GPU restart can settle. */
	retryDelayMs?: number;
	now?: () => number;
	schedule?: (fn: () => void, ms: number) => void;
	log?: Log;
	env?: NodeJS.ProcessEnv;
	electronApp?: App;
}

/**
 * At most `max` attempts in any `windowMs` span: a page that crashes on every
 * load is reloaded a few times, then left for the person (and the log) to see,
 * instead of looping.
 */
export function createRetryBudget(
	max: number,
	windowMs: number,
	now: () => number,
): () => boolean {
	const attempts: number[] = [];
	return () => {
		const t = now();
		while (attempts.length > 0 && t - attempts[0] >= windowMs) {
			attempts.shift();
		}
		if (attempts.length >= max) return false;
		attempts.push(t);
		return true;
	};
}

/**
 * The main window stayed white when its renderer died (GPU reset, crash, OOM:
 * seen under WSLg) or when the first load failed (dev server not up yet):
 * nothing reloaded it. Reload it, within a budget, and log why, so a white
 * window that comes back says what took it down.
 *
 * Not in the smoke test: there a lost renderer or a failed load is the failure
 * it reports (smoke-test.ts), not something to hide by reloading.
 */
export function guardMainWindow(
	win: BrowserWindow,
	options: WindowRecoveryOptions = {},
): void {
	const {
		maxAttempts = 3,
		windowMs = 60_000,
		retryDelayMs = 1_000,
		now = Date.now,
		schedule = (fn, ms) => {
			setTimeout(fn, ms);
		},
		log = console,
		env = process.env,
		electronApp = app,
	} = options;
	if (isSmokeTest(env)) return;
	logGpuProcessLoss(electronApp, log);
	const take = createRetryBudget(maxAttempts, windowMs, now);
	const contents = win.webContents;

	const recover = (why: string, action: () => void) => {
		if (!take()) {
			log.error(
				`[window-recovery] ${why}; ${maxAttempts} recoveries in ${windowMs / 1000} s already, the window is left as is`,
			);
			return;
		}
		log.warn(`[window-recovery] ${why}; reloading the window`);
		schedule(() => {
			if (!win.isDestroyed()) action();
		}, retryDelayMs);
	};

	contents.on("render-process-gone", (_event, details) => {
		if (details.reason === "clean-exit") return;
		recover(
			`renderer process gone (${details.reason}, exit code ${details.exitCode})`,
			() => contents.reload(),
		);
	});

	contents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			if (!isMainFrame || errorCode === ERR_ABORTED) return;
			recover(`page failed to load (${errorCode} ${errorDescription})`, () => {
				void contents.loadURL(validatedURL);
			});
		},
	);
}

/**
 * Log the GPU process going away: Chromium carries on (it restarts it or falls
 * back to software), but under WSLg that is when a window turns white, and the
 * log is the only trace left of it. Registered once per app, however many
 * windows are guarded.
 */
const gpuWatched = new WeakSet<App>();

export function logGpuProcessLoss(electronApp: App, log: Log = console): void {
	if (gpuWatched.has(electronApp)) return;
	gpuWatched.add(electronApp);
	electronApp.on("child-process-gone", (_event, details) => {
		if (details.type !== "GPU" || details.reason === "clean-exit") return;
		log.warn(
			`[window-recovery] GPU process gone (${details.reason}, exit code ${details.exitCode})`,
		);
	});
}
