/**
 * A path as the person reads it: relative to the open project when it lies
 * inside it, unchanged otherwise. Both separators are accepted, since a path
 * picked in a native dialog on Windows comes back with backslashes.
 */
export function relativeToProject(path: string, projectPath: string): string {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	const root = norm(projectPath);
	const file = norm(path);
	return root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : path;
}
