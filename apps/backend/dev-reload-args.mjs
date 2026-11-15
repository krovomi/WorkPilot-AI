// uvicorn --reload arguments for the backend dev server (dev-server.mjs).
// Kept apart from the launcher so tests/test_dev_reload_args.py can check them
// against uvicorn itself without starting a server.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

function isDirectory(path) {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Watch only the backend source directory, and leave out the virtualenv the
 * Electron PythonEnvManager installs into apps/backend/.venv (inside the
 * watched dir): without that exclude every pip install reload-storms the
 * server.
 *
 * The exclude has to be an ABSOLUTE path, because uvicorn's FileFilter
 * compares exclude dirs with the changed file's absolute parents. But uvicorn
 * only accepts an absolute exclude when that directory exists: otherwise
 * resolve_reload_patterns() hands it to Path.cwd().glob(), which raises
 * "Non-relative patterns are unsupported" (every Python from 3.12 on) and the
 * dev server dies before serving. A checkout whose venv lives at the repo root
 * (../../.venv, as dev-server.mjs creates it) has no apps/backend/.venv, so the
 * exclude is only passed when there is something to exclude.
 *
 * No glob pattern either (".venv/*"): the bundled Windows python.exe expands
 * wildcard argv into extra positional args and uvicorn exits with code 2.
 *
 * @param {string} backendDir absolute path of apps/backend
 * @param {(path: string) => boolean} [dirExists] injectable for tests
 * @returns {string[]}
 */
export function devReloadArgs(backendDir, dirExists = isDirectory) {
	const args = ["--reload", "--reload-dir", backendDir];
	const venv = join(backendDir, ".venv");
	if (dirExists(venv)) {
		args.push("--reload-exclude", venv);
	}
	return args;
}
