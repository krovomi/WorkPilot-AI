/**
 * Code links between two specs (#358, lot 3): what shared files and the
 * history miss, read from the code itself.
 *
 * - Cross imports: a file of one spec imports a module the other spec edits.
 * - Removed symbols: one spec's changes remove (or rename) an identifier that
 *   a file of the other spec still uses.
 *
 * Pure and language-agnostic: an import line is recognised by a closed list of
 * keywords many languages share (`import`, `from`, `require`, `#include`,
 * `use`, `using`, `@import`, `mod`, `source`…), a module by its file name, an
 * identifier by its characters. Nothing is parsed per language and no model
 * is called. The reader (`code-reader.ts`) gives the file contents and the
 * worktree diff; this module only turns them into an index and links.
 */

import type { Footprint } from "./scorer";

/** Each code link adds 1 to a pair's score, at most this much. */
export const MAX_CODE_WEIGHT = 3;
/** Removed symbols kept per spec: enough to score, bounded in memory. */
export const MAX_REMOVED_SYMBOLS = 200;

/** What a spec's files say, indexed for the pair checks. */
export interface SpecCode {
	/** Module key (`stem` or `parent/stem`) -> normalized files importing it. */
	imports: ReadonlyMap<string, readonly string[]>;
	/** Distinctive identifier -> normalized files using it. */
	symbols: ReadonlyMap<string, readonly string[]>;
	/** Distinctive identifiers its changes removed, sorted, at most `MAX_REMOVED_SYMBOLS`. */
	removed: readonly string[];
}

/** A file read for its code, by normalized path. */
export interface CodeFile {
	path: string;
	text: string;
}

/**
 * A line that imports, includes or loads something, in most languages: the
 * keyword opens the line (Python, JS/TS, Java, Kotlin, Go, Rust, C/C++,
 * Objective-C, C#, F#, PHP, Ruby, Elixir, Haskell, Swift, Dart, Scala, CSS,
 * shell, R, Julia…), or `require(` / `import(` appear anywhere (CommonJS,
 * Lua, dynamic imports).
 */
const IMPORT_LINE =
	/^(?:import|from|export\b.*\bfrom|require(?:_relative|_once)?|include(?:_once)?|#\s*(?:include|import)|@(?:import|use|forward)|use|using|global\s+using|open|(?:pub\s+)?mod|pub\s+use|extern\s+crate|library|source|load|alias|imports?)\b/;
const INLINE_IMPORT = /\b(?:require|import)\s*\(/;
/** Go's `import (` … `)` block. */
const IMPORT_BLOCK_OPEN = /^import\s*\($/;

/** File names that stand for their folder (`pkg/index.ts`, `pkg/__init__.py`). */
const INDEX_STEMS = new Set(["index", "__init__", "mod", "main", "lib", "init", "package"]);
/**
 * Names many folders have: importing `utils` says nothing about which one,
 * so these only match with their parent folder on the same line.
 */
const GENERIC_STEMS = new Set([
	"app",
	"base",
	"common",
	"config",
	"constants",
	"core",
	"helpers",
	"model",
	"models",
	"shared",
	"spec",
	"src",
	"styles",
	"test",
	"tests",
	"types",
	"util",
	"utils",
]);

const WORD_SPLIT = /[^\p{L}\p{N}_$-]+/u;
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

function words(line: string): string[] {
	return line
		.toLowerCase()
		.split(WORD_SPLIT)
		.map((word) => word.replace(/^-+|-+$/g, ""))
		.filter(Boolean);
}

/**
 * The key an import of this file would name: its stem, its folder for an
 * index file, `parent/stem` for a name many folders have. Null when the path
 * gives nothing to match (`.env`, a generic name at the root).
 */
export function moduleKey(normalizedPath: string): string | null {
	const segments = normalizedPath.split("/").filter(Boolean);
	const last = segments.pop();
	if (!last) return null;
	let stem = last.split(".")[0];
	if (INDEX_STEMS.has(stem)) stem = segments.pop() ?? "";
	stem = stem.replace(/^-+|-+$/g, "");
	if (stem.length < 2) return null;
	if (!GENERIC_STEMS.has(stem) && stem.length >= 3) return stem;
	const parent = segments.pop();
	return parent ? `${parent}/${stem}` : null;
}

/** Module keys an import line names: each word, and each pair of adjacent words. */
function lineKeys(line: string): string[] {
	const list = words(line);
	const keys = [...list];
	for (let i = 1; i < list.length; i++) keys.push(`${list[i - 1]}/${list[i]}`);
	return keys;
}

/** Every module key the file's import lines name. */
export function importKeys(text: string): Set<string> {
	const keys = new Set<string>();
	let inBlock = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (inBlock) {
			if (line.startsWith(")")) inBlock = false;
			else for (const key of lineKeys(line)) keys.add(key);
			continue;
		}
		if (IMPORT_BLOCK_OPEN.test(line)) {
			inBlock = true;
			continue;
		}
		if (IMPORT_LINE.test(line) || INLINE_IMPORT.test(line)) {
			for (const key of lineKeys(line)) keys.add(key);
		}
	}
	return keys;
}

/**
 * An identifier worth following across files: at least 4 characters and
 * shaped like a name someone chose (`camelCase`, `PascalCase` with a second
 * word, `snake_case`, `name2`), not an ordinary word a comment could hold.
 */
export function isDistinctive(identifier: string): boolean {
	if (identifier.length < 4) return false;
	return (
		/\p{Ll}\p{Lu}/u.test(identifier) ||
		/[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(identifier) ||
		/\p{L}\p{N}/u.test(identifier)
	);
}

export function distinctiveIdentifiers(text: string): Set<string> {
	const found = new Set<string>();
	for (const match of text.matchAll(IDENTIFIER)) {
		if (isDistinctive(match[0])) found.add(match[0]);
	}
	return found;
}

/**
 * Identifiers a unified diff removes: on removed lines, on no added line, and
 * in none of the files as they are now (`after`). A rename shows here as the
 * old name. File headers are skipped; only hunk lines count.
 */
export function removedSymbols(
	diff: string,
	after: Iterable<ReadonlySet<string>>,
): string[] {
	const removed = new Set<string>();
	const added = new Set<string>();
	let inHunk = false;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("diff ")) inHunk = false;
		else if (line.startsWith("@@")) inHunk = true;
		else if (inHunk && line.startsWith("-")) {
			for (const id of distinctiveIdentifiers(line.slice(1))) removed.add(id);
		} else if (inHunk && line.startsWith("+")) {
			for (const id of distinctiveIdentifiers(line.slice(1))) added.add(id);
		}
	}
	const still = [...after];
	return [...removed]
		.filter((id) => !added.has(id) && !still.some((tokens) => tokens.has(id)))
		.sort()
		.slice(0, MAX_REMOVED_SYMBOLS);
}

function addTo(index: Map<string, string[]>, key: string, file: string): void {
	const files = index.get(key);
	if (files) files.push(file);
	else index.set(key, [file]);
}

/** Indexes a spec's files (as its worktree or the project has them) and its diff. */
export function buildSpecCode(files: readonly CodeFile[], diff: string | null): SpecCode {
	const imports = new Map<string, string[]>();
	const symbols = new Map<string, string[]>();
	const tokensByFile: Array<Set<string>> = [];
	for (const file of files) {
		for (const key of importKeys(file.text)) addTo(imports, key, file.path);
		const tokens = distinctiveIdentifiers(file.text);
		tokensByFile.push(tokens);
		for (const token of tokens) addTo(symbols, token, file.path);
	}
	return {
		imports,
		symbols,
		removed: diff ? removedSymbols(diff, tokensByFile) : [],
	};
}

/** `y → x`: a file of `from` importing a module `to` edits, neither shared. */
function importLinksOneWay(
	to: Footprint,
	from: Footprint,
	fromCode: SpecCode,
	links: Set<string>,
): void {
	for (const [x, shownX] of to) {
		if (from.has(x)) continue;
		const key = moduleKey(x);
		for (const y of (key && fromCode.imports.get(key)) || []) {
			if (to.has(y)) continue;
			links.add(`${from.get(y) as string} → ${shownX}`);
		}
	}
}

/** `y → symbol`: a file of `user` still using what `remover` removes. */
function symbolLinksOneWay(
	remover: SpecCode,
	other: Footprint,
	user: Footprint,
	userCode: SpecCode,
	links: Set<string>,
): void {
	for (const symbol of remover.removed) {
		for (const y of userCode.symbols.get(symbol) ?? []) {
			if (other.has(y)) continue;
			links.add(`${user.get(y) as string} → ${symbol}`);
		}
	}
}

export interface CodeLinks {
	imports: string[];
	symbols: string[];
}

/** Code links between two specs, both ways, sorted; empty when either side was not read. */
export function codeLinks(
	a: Footprint,
	aCode: SpecCode | null | undefined,
	b: Footprint,
	bCode: SpecCode | null | undefined,
): CodeLinks {
	if (!aCode || !bCode) return { imports: [], symbols: [] };
	const imports = new Set<string>();
	importLinksOneWay(a, b, bCode, imports);
	importLinksOneWay(b, a, aCode, imports);
	const symbols = new Set<string>();
	symbolLinksOneWay(aCode, a, b, bCode, symbols);
	symbolLinksOneWay(bCode, b, a, aCode, symbols);
	const sort = (set: Set<string>) => [...set].sort((p, q) => p.localeCompare(q));
	return { imports: sort(imports), symbols: sort(symbols) };
}
