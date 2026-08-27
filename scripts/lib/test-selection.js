"use strict";
/**
 * Shared test-selection helpers for the git hooks.
 *
 * Used by:
 *   - scripts/pre-push.js     (diff vs upstream, conservative full-suite fallback)
 *   - scripts/staged-tests.js (diff vs index at commit time, skip-on-unmapped)
 *
 * Keeping the mapping logic in one place means the commit-time and push-time
 * gates can't drift apart.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const IS_WINDOWS = os.platform() === "win32";

/** Path of an executable inside a venv directory. */
function venvBin(dir, name) {
	return IS_WINDOWS
		? path.join(dir, ".venv", "Scripts", `${name}.exe`)
		: path.join(dir, ".venv", "bin", name);
}

/**
 * Locate a venv executable, checking every place the project creates venvs:
 * apps/backend/.venv, ./.venv, and .cache/.venv (install-backend.js default).
 */
function findVenvBin(root, name) {
	return [
		path.join(root, "apps", "backend"),
		root,
		path.join(root, ".cache"),
	]
		.map((d) => venvBin(d, name))
		.find((p) => fs.existsSync(p));
}

/**
 * Does pytest collect this file? Mirrors `python_files` in pytest.ini
 * (`test_*.py *_test.py`).
 */
function isPytestFile(file) {
	const base = path.basename(file);
	return base.endsWith(".py") && (base.startsWith("test_") || base.endsWith("_test.py"));
}

/**
 * Pick a pytest target list based on changed files.
 *
 * - Backend test file changed → run that file directly.
 * - Backend source file changed → run tests/ files matching the module name.
 * - When a source file maps to no test file:
 *     fallbackToFullSuite=true  → ["tests/"] (correctness > speed; pre-push)
 *     fallbackToFullSuite=false → unmapped files are skipped (commit-time —
 *                                 the pre-push gate and CI still run the full
 *                                 suite, so nothing escapes for long)
 */
function selectPytestTargets(root, changedFiles, options = {}) {
	const { fallbackToFullSuite = true } = options;
	if (!changedFiles) return fallbackToFullSuite ? ["tests/"] : [];
	const backendSrc = changedFiles.filter(
		(f) => f.startsWith("apps/backend/") && f.endsWith(".py"),
	);
	// Only files pytest would actually collect. `tests/` also holds standalone
	// scripts (check_syntax.py, run_all_tests.py, validation_script.py, …) that
	// call sys.exit() at import time. A normal `pytest tests/` run never touches
	// them because they do not match python_files, but naming them explicitly on
	// the command line makes pytest import them anyway — and the SystemExit
	// surfaces as a collection INTERNALERROR that aborts the whole run.
	const testChanges = changedFiles.filter(
		(f) => f.startsWith("tests/") && isPytestFile(f),
	);
	if (backendSrc.length === 0 && testChanges.length === 0) return [];

	const targets = new Set();
	for (const t of testChanges) targets.add(t);

	const allTests = [];
	function walk(dir) {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.isFile() && isPytestFile(e.name)) {
				allTests.push(full);
			}
		}
	}
	try {
		walk(path.join(root, "tests"));
	} catch {
		return fallbackToFullSuite ? ["tests/"] : [...targets];
	}

	let unmapped = false;
	for (const src of backendSrc) {
		const base = path.basename(src, ".py"); // e.g. "ci_discovery"
		const matches = allTests.filter((t) => path.basename(t).includes(base));
		if (matches.length === 0) {
			unmapped = true;
		} else {
			for (const m of matches) {
				targets.add(path.relative(root, m).replaceAll("\\", "/"));
			}
		}
	}

	if (unmapped && fallbackToFullSuite) return ["tests/"];
	return [...targets];
}

module.exports = { IS_WINDOWS, venvBin, findVenvBin, selectPytestTargets };
