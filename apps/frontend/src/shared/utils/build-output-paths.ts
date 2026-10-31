/**
 * Build outputs never shown as a task's changes: anything under a `bin/` or
 * `obj/` folder, at any depth, whatever the project. Mirrors
 * `ALWAYS_EXCLUDED` in apps/backend/core/build_artifacts.py, which keeps
 * them out of the branch; this filter covers a diff read before that runs.
 */
const BUILD_OUTPUT_DIRS = new Set(["bin", "obj"]);

export function isBuildOutputPath(filePath: string): boolean {
	const segments = filePath.replaceAll("\\", "/").split("/");
	// The last segment is the file itself: a file named `bin` is not a folder.
	return segments
		.slice(0, -1)
		.some((segment) => BUILD_OUTPUT_DIRS.has(segment.toLowerCase()));
}
