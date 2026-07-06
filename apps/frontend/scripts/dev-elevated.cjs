#!/usr/bin/env node
/**
 * Cross-platform dev launcher (`pnpm run dev`).
 *
 * On **Windows** it runs WorkPilot's Electron dev stack **elevated (admin)**;
 * on **macOS/Linux** it is a transparent passthrough to the normal dev stack.
 *
 * Why elevate on Windows: the visual-proof capture (Win32 PrintWindow) and UI
 * Automation can only drive/screenshot a desktop app running at the same
 * integrity level. The EBP heavy client requires administrator, so WorkPilot
 * must be elevated too — otherwise captures come back blank and navigation is
 * blocked (Windows UIPI).
 *
 * Why NOT elevate on macOS/Linux: there is no such elevated-app scenario there
 * (EBP is Windows-only), and running a GUI/Electron app as root is harmful and a
 * security risk. So on those OSes we just run the dev stack as-is.
 *
 * How (Windows): we elevate the whole `electron-vite dev` process (via
 * `dev:vite`), NOT just the Electron child. electron-vite calls
 * `ps.on('close', process.exit)`, so if Electron alone were relaunched elevated
 * and the original exited, the Vite renderer dev server would be torn down and
 * the elevated window would load a dead URL. Elevating electron-vite itself
 * keeps the dev server + Electron in one elevated process — HMR intact, no race.
 *
 * Behaviour:
 *   - macOS/Linux, already elevated, or WORKPILOT_NO_ELEVATE set → run the dev
 *     stack in THIS process (logs stay inline);
 *   - Windows + not elevated → relaunch `dev:vite` in a new elevated console via
 *     UAC (a separate window; that's an unavoidable Windows limitation when
 *     going from a non-elevated to an elevated process).
 *
 * Opt out (no UAC, no separate console — e.g. when iterating on main-process
 * code): `pnpm run dev:noadmin`, or set WORKPILOT_NO_ELEVATE=1.
 */
const { spawnSync, execFileSync } = require("node:child_process");

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const optedOut = TRUTHY.has(String(process.env.WORKPILOT_NO_ELEVATE || "").toLowerCase());
// Diagnostics only: print the decision + would-be command, then exit without
// spawning Electron or prompting for UAC (used by tests / manual checks).
const dryRun = TRUTHY.has(String(process.env.WORKPILOT_DEV_DRYRUN || "").toLowerCase());

// Env vars worth carrying into the elevated console (UAC starts a fresh env).
// Deliberately NOT ELECTRON_*/VITE_*: electron-vite sets those itself when it
// spawns Electron, and forwarding ELECTRON_RUN_AS_NODE would make Electron run
// as plain Node and never open a window. The launcher's own control vars are
// excluded so they don't leak into the elevated run.
const FORWARD_ENV_EXCLUDE = new Set([
	"WORKPILOT_NO_ELEVATE",
	"WORKPILOT_DEV_DRYRUN",
]);
function shouldForwardEnv(key) {
	if (FORWARD_ENV_EXCLUDE.has(key)) return false;
	return /^(DEBUG|NODE_ENV|APP_LANGUAGE)$/.test(key) || /^(WORKPILOT_|WP_)/.test(key);
}

/**
 * Are we already running elevated on Windows? Uses the classic `net session`
 * probe: it only succeeds for administrators (non-admins get "Access is
 * denied"). Fast and dependency-free. Windows-only — never called elsewhere.
 */
function isWindowsElevated() {
	try {
		execFileSync("net", ["session"], { stdio: "ignore", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run the real dev stack (`dev:vite`) in this process, inheriting stdio.
 * `shell: true` makes the bare `npm` resolve cross-OS (npm.cmd on Windows via
 * PATHEXT, npm on POSIX).
 */
function runDevInProcess() {
	if (dryRun) {
		console.log("[dev:dryrun] would run in-process: npm run dev:vite");
		process.exit(0);
	}
	const result = spawnSync("npm", ["run", "dev:vite"], {
		stdio: "inherit",
		shell: true,
	});
	process.exit(result.status == null ? 1 : result.status);
}

/** PowerShell single-quote escape. */
function psQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Relaunch `dev:vite` in a new elevated console via UAC. Forwards a curated set
 * of app-level env vars (e.g. `dev:debug`'s DEBUG=true) so they survive the
 * fresh elevated environment, and waits so `pnpm run dev` stays "running" for as
 * long as the app is open. The Vite dev URL is NOT forwarded — the elevated
 * `electron-vite` starts its own dev server and sets it for its own Electron.
 */
function relaunchElevated() {
	const setPrefix = Object.entries(process.env)
		.filter(([key, val]) => val != null && shouldForwardEnv(key))
		.map(([key, val]) => `set "${key}=${String(val).replace(/"/g, "")}" && `)
		.join("");
	// `dev:vite` (not `dev`) so the elevated console never re-enters this
	// launcher — no recursion, no reliance on the elevation probe there. `npm`
	// is bundled with Node, so it's always on PATH in the fresh elevated console.
	//
	// The `cd /d` is REQUIRED: `Start-Process -Verb RunAs` ignores
	// `-WorkingDirectory`, so an elevated process starts in C:\Windows\System32.
	// Without this cd, npm would look for package.json there and fail (ENOENT).
	const innerCmd = `cd /d "${process.cwd()}" && ${setPrefix}npm run dev:vite`;
	const psCommand =
		"Start-Process -FilePath 'cmd.exe' -Verb RunAs -Wait " +
		`-ArgumentList '/k', ${psQuote(innerCmd)}`;

	if (dryRun) {
		console.log(`[dev:dryrun] would elevate via:\n${psCommand}`);
		process.exit(0);
	}
	console.log(
		"[dev] Relaunching WorkPilot dev as administrator in a new console (UAC)…\n" +
			"      Front-end logs will appear in that elevated window.\n" +
			"      Skip elevation with: pnpm run dev:noadmin",
	);
	try {
		execFileSync(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", psCommand],
			{ stdio: "inherit", windowsHide: false },
		);
		process.exit(0);
	} catch (err) {
		console.warn(
			"[dev] Elevation was declined or failed — running non-elevated.\n" +
				"      Visual proof on an elevated app (EBP) will capture a blank frame\n" +
				"      and automated navigation is disabled. Set WORKPILOT_NO_ELEVATE=1 to silence.",
			err && err.message ? `\n      (${err.message})` : "",
		);
		runDevInProcess();
	}
}

// macOS/Linux never elevate (short-circuits before the Windows-only probe).
// On Windows we elevate only when not already admin and not opted out.
if (process.platform !== "win32" || optedOut || isWindowsElevated()) {
	runDevInProcess();
} else {
	relaunchElevated();
}
