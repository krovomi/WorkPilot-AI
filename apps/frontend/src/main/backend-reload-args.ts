import { statSync } from "node:fs";
import { resolve } from "node:path";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * uvicorn `--reload` arguments for the backend main starts in development.
 *
 * `--reload` belongs to development only: in a packaged app the backend source
 * never changes, and the watcher costs a second supervisor process plus roughly
 * double the memory, while a stray write under backendDir (a log, a cache) can
 * restart the API under the user's feet mid-task.
 *
 * The watcher sees only backendDir. PythonEnvManager installs into
 * backendDir/.venv, INSIDE that dir, so it is excluded or every pip install
 * reload-storms the server. The exclude must be ABSOLUTE (uvicorn's FileFilter
 * compares exclude dirs with the changed file's absolute parents), and uvicorn
 * only accepts an absolute exclude for a directory that exists: otherwise
 * resolve_reload_patterns() globs it and raises "Non-relative patterns are
 * unsupported", killing the backend before it serves. So it is passed only
 * when the venv is there (a venv at the repo root leaves none in backendDir).
 *
 * Never a glob exclude (".venv/*"): the bundled Windows python.exe expands
 * wildcard argv into extra positional args and uvicorn exits with code 2.
 * apps/backend/dev-reload-args.mjs holds the same rule for `pnpm dev`.
 */
export function backendReloadArgs(
	backendDir: string,
	isDev: boolean,
	dirExists: (path: string) => boolean = isDirectory,
): string[] {
	if (!isDev) return [];
	const args = ["--reload", "--reload-dir", backendDir];
	const venv = resolve(backendDir, ".venv");
	if (dirExists(venv)) args.push("--reload-exclude", venv);
	return args;
}
