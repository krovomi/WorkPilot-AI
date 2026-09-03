/**
 * Turns the project name someone typed into a folder name.
 *
 * Accents are folded, not dropped. The app ships in French, and stripping
 * every character outside `[a-z0-9-_]` turns `Café` into `caf` and `Élan`
 * into `lan` — a silent corruption of the name that was typed, not a
 * sanitization. A name written in a non-Latin script still reduces to the
 * empty string, which the caller reports as an invalid name rather than
 * creating a folder nobody asked for.
 */
export function sanitizeProjectFolderName(name: string): string {
	return name
		.normalize("NFD")
		.replaceAll(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replaceAll(/\s+/g, "-")
		.replaceAll(/[^a-z0-9-_]/g, "")
		.replaceAll(/-+/g, "-")
		.replaceAll(/^-|-$/g, "");
}

/**
 * Joins a project location to a folder name, reusing the separator the
 * location already carries.
 *
 * The renderer has no `node:path`, and hard-coding `/` produced
 * `C:\\Repositories/my-app` on Windows and broke UNC locations outright.
 */
export function joinProjectPath(location: string, folderName: string): string {
	const trimmed = location.replace(/[\\/]+$/, "");
	const separator = trimmed.includes("\\") ? "\\" : "/";
	return `${trimmed}${separator}${folderName}`;
}
