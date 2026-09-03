import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Directories that never contain hand-written route declarations. */
export const EXCLUDED_DIRS = new Set([
	"node_modules",
	".git",
	"__pycache__",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".cache",
	".venv",
	"venv",
	"out",
	".turbo",
	".worktrees",
	"vendor",
	"target",
	".gradle",
	".maven",
	"obj",
	"bin",
	".vs",
]);

export function walkFiles(
	dir: string,
	extensions: string[],
	maxDepth = 12,
	depth = 0,
): string[] {
	if (depth > maxDepth) return [];
	let results: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (EXCLUDED_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from assignment
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			results = results.concat(
				walkFiles(full, extensions, maxDepth, depth + 1),
			);
		} else if (extensions.some((ext) => full.endsWith(ext))) {
			results.push(full);
		}
	}
	return results;
}

export function readFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}
