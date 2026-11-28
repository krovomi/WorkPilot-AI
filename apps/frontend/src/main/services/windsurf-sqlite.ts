/**
 * better-sqlite3, loaded when Windsurf's state database is read rather than
 * when the main process starts: its native binding is built for this
 * Electron at install time, and an app whose binding is missing must still
 * start (the Windsurf readers then say the module is not available).
 *
 * A plain `require`, as before: the main bundle keeps it external, and it
 * resolves inside the packaged app the way every other native module does.
 * It lives in its own module so tests can stand in for the binding.
 */
import type BetterSqlite3 from "better-sqlite3";

export function loadBetterSqlite(): typeof BetterSqlite3 {
	return require("better-sqlite3");
}
