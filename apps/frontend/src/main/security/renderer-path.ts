/**
 * A path the renderer sends is a request, not a location.
 *
 * The renderer is not trusted (security.md, S6): whatever it names, the main
 * process resolves it (symlinks included) and serves it only when the result
 * sits inside a root the main process already knows, a registered project by
 * default. Rejecting `..` is not enough: `/repo/link` may point at `~/.ssh`,
 * and `/repo-other` shares a prefix with `/repo`.
 *
 * Every function here answers `null` for a refusal, so a handler can fail
 * closed with its own message and never echo what it was given.
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isWindows } from "../platform";
import { projectStore } from "../project-store";

export type PathKind = "file" | "directory" | "any";

function realpathOrNull(target: string): string | null {
	try {
		return realpathSync(target);
	} catch {
		return null;
	}
}

/**
 * `target` is `root` or below it. Both must already be resolved. Windows
 * paths compare without case, as the filesystem does.
 */
export function isWithinRoot(target: string, root: string): boolean {
	const fold = (p: string) => (isWindows() ? p.toLowerCase() : p);
	const relative = path.relative(fold(root), fold(target));
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function hasKind(resolved: string, kind: PathKind): boolean {
	if (kind === "any") return true;
	try {
		const stats = statSync(resolved);
		return kind === "file" ? stats.isFile() : stats.isDirectory();
	} catch {
		return false;
	}
}

/**
 * The existing path `target`, resolved, when it lies inside one of `roots`
 * and is of `kind`. `null` otherwise, including when it does not exist.
 */
export function resolveWithinRoots(
	target: unknown,
	roots: readonly string[],
	kind: PathKind = "any",
): string | null {
	if (typeof target !== "string" || !path.isAbsolute(target)) return null;
	const resolved = realpathOrNull(target);
	if (!resolved || !hasKind(resolved, kind)) return null;
	const inside = roots.some((root) => {
		const base = realpathOrNull(root);
		return base !== null && isWithinRoot(resolved, base);
	});
	return inside ? resolved : null;
}

/**
 * `relative` joined under `base`, resolved, when the result stays inside
 * `base`. For a handler that receives a project and a path relative to it.
 */
export function resolveUnder(
	base: string,
	relative: unknown,
	kind: PathKind = "any",
): string | null {
	if (typeof relative !== "string" || path.isAbsolute(relative)) return null;
	return resolveWithinRoots(path.join(base, relative), [base], kind);
}

/**
 * What the user picked in a native dialog (or what the main process created
 * at their request) during this session. The renderer cannot add to it: only
 * the dialog and folder-creation handlers call `rememberUserChosenPath`.
 */
const userChosenPaths = new Set<string>();

export function rememberUserChosenPath(chosen: string): void {
	const resolved = realpathOrNull(chosen);
	if (resolved) userChosenPaths.add(resolved);
}

/** For tests: forget every choice. */
export function forgetUserChosenPaths(): void {
	userChosenPaths.clear();
}

/** `target` resolved inside something the user picked in a dialog, or `null`. */
export function resolveUserChosen(
	target: unknown,
	kind: PathKind = "any",
): string | null {
	return resolveWithinRoots(target, [...userChosenPaths], kind);
}

/**
 * Where `relative` would be written under `base`: the joined path, when it
 * stays inside `base` and its closest existing ancestor (links resolved) does
 * too. The file itself need not exist. `null` otherwise.
 */
export function resolveWritableUnder(
	base: string,
	relative: unknown,
): string | null {
	if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
		return null;
	}
	const root = realpathOrNull(base);
	if (!root) return null;
	const target = path.resolve(root, relative);
	if (target === root || !isWithinRoot(target, root)) return null;
	let ancestor = target;
	while (!realpathOrNull(ancestor)) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor) return null;
		ancestor = parent;
	}
	const resolvedAncestor = realpathOrNull(ancestor);
	if (!resolvedAncestor || !isWithinRoot(resolvedAncestor, root)) return null;
	return path.join(resolvedAncestor, path.relative(ancestor, target));
}

/** The paths of the registered projects. */
export function knownProjectRoots(): string[] {
	return projectStore.getProjects().map((project) => project.path);
}

/**
 * `target` resolved inside a registered project or inside a folder the user
 * picked in a dialog (a project being added is not registered yet), or
 * `null`.
 */
export function resolveInProject(
	target: unknown,
	kind: PathKind = "any",
): string | null {
	return resolveWithinRoots(
		target,
		[...knownProjectRoots(), ...userChosenPaths],
		kind,
	);
}

/**
 * The registered project directory `projectPath` names, resolved. A handler
 * that runs something in a project takes it from here, so the renderer can
 * only name a project the user added.
 */
export function resolveKnownProject(projectPath: unknown): string | null {
	if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) {
		return null;
	}
	const resolved = realpathOrNull(projectPath);
	if (!resolved || !hasKind(resolved, "directory")) return null;
	const known = knownProjectRoots().some((root) => {
		const base = realpathOrNull(root);
		return (
			base !== null && isWithinRoot(resolved, base) && isWithinRoot(base, resolved)
		);
	});
	return known ? resolved : null;
}

/**
 * Whether `target` may become a project: a folder the user picked (or had
 * the app create) this session, or one already registered. Registering any
 * path the renderer names would make every other check here moot.
 */
export function isAddableProject(target: unknown): boolean {
	return (
		resolveUserChosen(target, "directory") !== null ||
		resolveInProject(target, "directory") !== null
	);
}
