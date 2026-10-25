/**
 * A tool path typed in the settings is checked before the main process runs it.
 *
 * `pythonPath`, `gitPath`, `githubCLIPath`, `gitlabCLIPath` and `claudePath`
 * stay free text: they are the user's choice. But the main process executes
 * them (`--version` to validate, then for every task), and the renderer is not
 * trusted (security.md, S6). So a new value must be either a bare command name
 * of that tool, found on the PATH, or an absolute path to an existing
 * executable file named like the tool, outside every registered project and
 * outside the temporary folder: the places an agent or a downloaded file can
 * write to. A value that is already stored is kept as it is.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export { TOOL_PATH_REFUSED } from "../../shared/constants/tool-paths";
import { isWindows } from "../platform";
import { isWithinRoot, knownProjectRoots } from "./renderer-path";

/** The settings fields holding a tool path, and the tool each one names. */
export const TOOL_PATH_FIELDS = {
	pythonPath: "python",
	gitPath: "git",
	githubCLIPath: "gh",
	gitlabCLIPath: "glab",
	claudePath: "claude",
} as const;

export type ToolPathField = keyof typeof TOOL_PATH_FIELDS;
type Tool = (typeof TOOL_PATH_FIELDS)[ToolPathField];

const TOOL_NAMES: Readonly<Record<Tool, RegExp>> = {
	python: /^(python(\d+(\.\d+)*)?w?|py)$/,
	git: /^git$/,
	gh: /^gh$/,
	glab: /^glab$/,
	claude: /^claude$/,
};

// The Windows launcher takes its version as an argument: "py -3", "py -3.12".
const PY_LAUNCHER = /^py( -\d+(\.\d+)*)?$/;

const WINDOWS_EXTENSIONS = /\.(exe|cmd|bat)$/;

function toolName(file: string): string {
	const name = file.toLowerCase();
	return isWindows() ? name.replace(WINDOWS_EXTENSIONS, "") : name;
}

function realpathOrNull(target: string): string | null {
	try {
		return realpathSync(target);
	} catch {
		return null;
	}
}

function isExecutableFile(resolved: string): boolean {
	try {
		if (!statSync(resolved).isFile()) return false;
		// Windows has no execute bit: the name check above stands for it.
		if (!isWindows()) accessSync(resolved, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Folders a new tool path may not point into, resolved. */
export function untrustedToolRoots(
	projectRoots: readonly string[] = knownProjectRoots(),
): string[] {
	return [...projectRoots, os.tmpdir()]
		.map(realpathOrNull)
		.filter((root): root is string => root !== null);
}

export function isAcceptableToolPath(
	tool: Tool,
	value: string,
	roots: readonly string[] = untrustedToolRoots(),
): boolean {
	const trimmed = value.trim();
	if (trimmed === "") return true;

	// A bare name is looked up on the PATH, as the shell would.
	if (!/[\\/]/.test(trimmed)) {
		return tool === "python" && isWindows()
			? PY_LAUNCHER.test(trimmed.toLowerCase()) ||
					TOOL_NAMES.python.test(toolName(trimmed))
			: TOOL_NAMES[tool].test(toolName(trimmed));
	}

	if (!path.isAbsolute(trimmed)) return false;
	// The name the user gave, not its target: npm links `claude` to `cli.js`
	// and the native installer to a version number.
	if (!TOOL_NAMES[tool].test(toolName(path.basename(trimmed)))) return false;

	const resolved = realpathOrNull(trimmed);
	if (!resolved || !isExecutableFile(resolved)) return false;
	const given = path.resolve(trimmed);
	return !roots.some(
		(root) => isWithinRoot(resolved, root) || isWithinRoot(given, root),
	);
}

/**
 * The first tool path of `update` that changes the stored value and is not
 * acceptable, or `null` when every one may be saved.
 */
export function refusedToolPath(
	update: Partial<Record<ToolPathField, unknown>>,
	stored: Partial<Record<ToolPathField, unknown>>,
	roots?: readonly string[],
): ToolPathField | null {
	let checkedRoots = roots;
	for (const field of Object.keys(TOOL_PATH_FIELDS) as ToolPathField[]) {
		if (!(field in update)) continue;
		const value = update[field];
		if (value === undefined || value === null || value === stored[field]) {
			continue;
		}
		if (typeof value !== "string") return field;
		checkedRoots ??= untrustedToolRoots();
		if (!isAcceptableToolPath(TOOL_PATH_FIELDS[field], value, checkedRoots)) {
			return field;
		}
	}
	return null;
}
