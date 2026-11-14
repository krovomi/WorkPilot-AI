/**
 * What the Live Companion watches, and what it reads of a change.
 *
 * chokidar 4 dropped glob support, and the app ships chokidar 6: the service
 * still handed it `["**\/*.ts", …]` with a `cwd`, so it watched paths that do
 * not exist and never saw a single change. It now watches the project folder
 * and filters with the predicate built here.
 *
 * Patterns stay globs in the config (`~/.workpilot/live_companion/config.json`)
 * but only two shapes are understood, which is all the defaults use:
 *
 * - `**\/*<suffix>`: a file whose name ends with `<suffix>` (`.ts`, `.min.js`);
 * - `**\/<dir>/**`: anything under a folder named `<dir>`.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

/** Every stack the app supports: web front ends, back ends, mobile, scripts. */
export const DEFAULT_WATCH_EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".vue",
	".svelte",
	".astro",
	".html",
	".css",
	".scss",
	".py",
	".rs",
	".go",
	".java",
	".kt",
	".kts",
	".scala",
	".groovy",
	".cs",
	".fs",
	".vb",
	".razor",
	".cshtml",
	".swift",
	".m",
	".dart",
	".rb",
	".php",
	".c",
	".h",
	".cpp",
	".cc",
	".hpp",
	".ex",
	".exs",
	".erl",
	".lua",
	".r",
	".jl",
	".zig",
	".sql",
	".sh",
	".ps1",
] as const;

/** Build output, dependencies, caches and the app's own worktrees. */
export const DEFAULT_IGNORED_DIRS = [
	"node_modules",
	".git",
	".workpilot",
	"dist",
	"build",
	"out",
	"coverage",
	"__pycache__",
	"venv",
	".venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	"bin",
	"obj",
	"target",
	".gradle",
	".idea",
	".vs",
	".dart_tool",
	"Pods",
	"DerivedData",
	".next",
	".nuxt",
	".svelte-kit",
	".angular",
	".expo",
	"vendor",
] as const;

export const DEFAULT_WATCH_PATTERNS = DEFAULT_WATCH_EXTENSIONS.map(
	(ext) => `**/*${ext}`,
);

export const DEFAULT_IGNORE_PATTERNS = [
	...DEFAULT_IGNORED_DIRS.map((dir) => `**/${dir}/**`),
	"**/*.min.js",
	"**/*.map",
];

/**
 * The defaults before this fix. `updateConfig` used to write the whole
 * merged config, so a user who ever ticked a box has these frozen in their
 * file; they are read as "the defaults" so new stacks reach them too.
 */
const LEGACY_WATCH_PATTERNS = [
	"**/*.ts",
	"**/*.tsx",
	"**/*.js",
	"**/*.jsx",
	"**/*.py",
	"**/*.rs",
	"**/*.go",
	"**/*.java",
	"**/*.cs",
	"**/*.rb",
	"**/*.php",
	"**/*.vue",
	"**/*.svelte",
];
const LEGACY_IGNORE_PATTERNS = [
	"**/node_modules/**",
	"**/.git/**",
	"**/dist/**",
	"**/build/**",
	"**/__pycache__/**",
	"**/venv/**",
	"**/.venv/**",
	"**/*.min.js",
	"**/*.map",
];

function sameList(a: unknown, b: readonly string[]): boolean {
	return (
		Array.isArray(a) &&
		a.length === b.length &&
		a.every((item, index) => item === b[index])
	);
}

export function isLegacyWatchPatterns(value: unknown): boolean {
	return sameList(value, LEGACY_WATCH_PATTERNS);
}

export function isLegacyIgnorePatterns(value: unknown): boolean {
	return sameList(value, LEGACY_IGNORE_PATTERNS);
}

interface CompiledPatterns {
	suffixes: string[];
	dirs: Set<string>;
}

function compile(patterns: readonly string[]): CompiledPatterns {
	const suffixes: string[] = [];
	const dirs = new Set<string>();
	for (const raw of patterns) {
		const pattern = raw.replaceAll("\\", "/").trim();
		const dir = /^\*\*\/([^*/]+)\/\*\*$/.exec(pattern);
		if (dir) {
			dirs.add(dir[1]);
			continue;
		}
		const suffix = /^\*\*\/\*([^*/]+)$/.exec(pattern);
		if (suffix) suffixes.push(suffix[1].toLowerCase());
	}
	return { suffixes, dirs };
}

/**
 * chokidar's `ignored` predicate for `projectDir`: true for anything under an
 * ignored folder, and for a file whose name matches no watch pattern (or an
 * ignore pattern). A folder without its stats yet is only judged by its name,
 * so chokidar never descends into `node_modules`.
 */
export function buildIgnoredPredicate(
	projectDir: string,
	watchPatterns: readonly string[],
	ignorePatterns: readonly string[],
): (candidate: string, stats?: { isFile(): boolean }) => boolean {
	const watch = compile(watchPatterns);
	const ignore = compile(ignorePatterns);
	const root = path.resolve(projectDir);

	return (candidate, stats) => {
		const relative = path.relative(root, path.resolve(candidate));
		if (!relative || relative.startsWith("..")) return false;
		const segments = relative.split(/[\\/]/);
		if (segments.some((segment) => ignore.dirs.has(segment))) return true;
		if (!stats?.isFile()) return false;
		const name = segments[segments.length - 1].toLowerCase();
		if (ignore.suffixes.some((suffix) => name.endsWith(suffix))) return true;
		return !watch.suffixes.some((suffix) => name.endsWith(suffix));
	};
}

const LANGUAGES: Record<string, string> = {
	".ts": "TypeScript",
	".mts": "TypeScript",
	".cts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",
	".jsx": "JavaScript",
	".vue": "Vue",
	".svelte": "Svelte",
	".astro": "Astro",
	".html": "HTML",
	".css": "CSS",
	".scss": "SCSS",
	".py": "Python",
	".rs": "Rust",
	".go": "Go",
	".java": "Java",
	".kt": "Kotlin",
	".kts": "Kotlin",
	".scala": "Scala",
	".groovy": "Groovy",
	".cs": "C#",
	".fs": "F#",
	".vb": "Visual Basic",
	".razor": "Razor (Blazor)",
	".cshtml": "Razor",
	".swift": "Swift",
	".m": "Objective-C",
	".dart": "Dart",
	".rb": "Ruby",
	".php": "PHP",
	".c": "C",
	".h": "C/C++",
	".cpp": "C++",
	".cc": "C++",
	".hpp": "C++",
	".ex": "Elixir",
	".exs": "Elixir",
	".erl": "Erlang",
	".lua": "Lua",
	".r": "R",
	".jl": "Julia",
	".zig": "Zig",
	".sql": "SQL",
	".sh": "Shell",
	".ps1": "PowerShell",
};

export function detectLanguage(filePath: string): string {
	return LANGUAGES[path.extname(filePath).toLowerCase()] ?? "Unknown";
}

/** What the analyzer reads of one change. */
export const MAX_CHANGE_CHARS = 4000;
/** A file larger than this is not read in full to take its head. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ChangeContent {
	/** The diff, or the head of the file. */
	text: string;
	/** `diff` for a git diff, `file` for the head of a new or untracked file. */
	kind: "diff" | "file";
}

function git(projectDir: string, args: string[]): string | null {
	try {
		// argv, not a shell string: `relPath` is whatever the repository holds.
		return execFileSync("git", args, {
			cwd: projectDir,
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

function readHead(fullPath: string): string {
	try {
		if (statSync(fullPath).size > MAX_FILE_BYTES) return "";
		const buffer = Buffer.alloc(MAX_CHANGE_CHARS);
		const fd = openSync(fullPath, "r");
		try {
			const read = readSync(fd, buffer, 0, buffer.length, 0);
			const head = buffer.subarray(0, read);
			// A NUL byte means binary content: nothing to review.
			return head.includes(0) ? "" : head.toString("utf-8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/**
 * The text the analyzer gets for a change: the git diff of a tracked file,
 * otherwise the head of the file (a new file, an untracked one, a folder that
 * is not a git repository). Nothing for a deletion.
 */
export function readChangeContent(
	projectDir: string,
	relPath: string,
	changeType: string,
): ChangeContent {
	if (changeType === "deleted") return { text: "", kind: "diff" };
	const fullPath = path.join(projectDir, relPath);
	if (changeType === "modified") {
		const diff = git(projectDir, ["diff", "--", relPath]);
		if (diff?.trim()) return { text: diff.slice(0, MAX_CHANGE_CHARS), kind: "diff" };
		// Tracked and unchanged against the index (saved twice, staged): nothing new.
		const tracked = git(projectDir, ["ls-files", "--error-unmatch", "--", relPath]);
		if (tracked !== null) return { text: "", kind: "diff" };
	}
	return { text: readHead(fullPath), kind: "file" };
}
