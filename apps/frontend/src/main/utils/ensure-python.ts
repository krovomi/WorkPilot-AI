/**
 * Python interpreter for the analysis runners, initialized on demand.
 *
 * The managed environment (venv in dev, bundled Python once packaged) is set up
 * lazily: the first task, merge or project load triggers it. A feature page
 * opened before any of those (Docs et dérive, Accessibilité, Conformité…) used
 * to read `pythonEnvManager.getPythonPath()` while it was still null and failed
 * with "Python environment not ready". These helpers start (or join) the
 * initialization instead, so the first scan simply waits for it.
 */

import { pythonEnvManager } from "../python-env-manager";
import { getEffectiveSourcePath } from "../updater/path-resolver";

const NOT_READY = "Python environment not ready";

async function initialize(): Promise<{ path: string | null; reason?: string }> {
	const ready = pythonEnvManager.getPythonPath();
	if (ready) return { path: ready };
	try {
		const source = getEffectiveSourcePath();
		if (!source) return { path: null, reason: "WorkPilot AI backend not found" };
		const status = await pythonEnvManager.initialize(source);
		if (status.ready && status.pythonPath) return { path: status.pythonPath };
		return { path: null, reason: status.error || "initialization failed" };
	} catch (err) {
		return { path: null, reason: err instanceof Error ? err.message : String(err) };
	}
}

/** The managed Python, initialized first when needed; null when that fails. */
export async function readyPythonPath(): Promise<string | null> {
	return (await initialize()).path;
}

/** The managed Python, initialized first when needed; throws with the reason. */
export async function requirePythonPath(): Promise<string> {
	const { path, reason } = await initialize();
	if (!path) throw new Error(reason ? `${NOT_READY}: ${reason}` : NOT_READY);
	return path;
}
