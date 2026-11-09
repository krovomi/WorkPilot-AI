/**
 * Syntax highlighting of a diff, for every language the code editor knows
 * (CodeMirror's language-data: C#, TypeScript, Python, Go, Rust, Java, Kotlin,
 * Swift, Dart, PHP, Ruby, SQL, YAML, Vue, HTML…).
 *
 * A hunk is a fragment of a file, so each side is rebuilt as text (old side =
 * context + removed lines, new side = context + added lines) and parsed whole:
 * a multi-line string or comment is coloured as in the editor, not line by
 * line. The tokens are then handed back to the diff lines they fall on.
 */
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
	classHighlighter,
	highlightTree,
	tagHighlighter,
	tags,
} from "@lezer/highlight";
import { useEffect, useMemo, useState } from "react";
import type { DiffLine } from "./diff-model";

/** A [from, to) range of a line and its token classes (`tok-keyword`…). */
export interface SyntaxToken {
	from: number;
	to: number;
	className: string;
}

/** Past this size the patch is shown without colours (parse cost). */
const MAX_HIGHLIGHT_CHARS = 400_000;

/**
 * Extensions language-data does not list, mapped to the grammar that reads
 * them best: .NET project and markup files are XML, Razor pages are HTML.
 */
const EXTRA_EXTENSIONS: Record<string, string> = {
	csproj: "XML",
	fsproj: "XML",
	vbproj: "XML",
	props: "XML",
	targets: "XML",
	nuspec: "XML",
	resx: "XML",
	xaml: "XML",
	axaml: "XML",
	config: "XML",
	plist: "XML",
	razor: "HTML",
	cshtml: "HTML",
	blade: "HTML",
	tf: "Shell",
};

export function findLanguage(path: string): LanguageDescription | null {
	const basename = path.replaceAll("\\", "/").split("/").pop() ?? "";
	const direct = LanguageDescription.matchFilename(languages, basename);
	if (direct) return direct;
	const extension = basename.split(".").pop()?.toLowerCase() ?? "";
	const name = EXTRA_EXTENSIONS[extension];
	return name ? LanguageDescription.matchLanguageName(languages, name) : null;
}

const loaded = new Map<string, Promise<LanguageSupport | null>>();

function loadLanguage(
	description: LanguageDescription,
): Promise<LanguageSupport | null> {
	let pending = loaded.get(description.name);
	if (!pending) {
		pending = description.load().catch(() => null);
		loaded.set(description.name, pending);
	}
	return pending;
}

type Parser = LanguageSupport["language"]["parser"];

/**
 * Classes classHighlighter does not give, added to its own (`tok-*`): function
 * names, control keywords, tags and attributes, as the code editor colours them.
 */
const extraHighlighter = tagHighlighter([
	{
		tag: [
			tags.function(tags.variableName),
			tags.function(tags.propertyName),
			tags.function(tags.definition(tags.variableName)),
		],
		class: "tok-function",
	},
	{ tag: [tags.controlKeyword, tags.moduleKeyword], class: "tok-control" },
	{ tag: tags.tagName, class: "tok-tagName" },
	{ tag: tags.attributeName, class: "tok-attributeName" },
]);
const highlighters = [classHighlighter, extraHighlighter];

interface SideText {
	text: string;
	/** Start offset in `text` of each line, and the diff line it came from. */
	starts: number[];
	lineIndexes: number[];
}

function buildSide(lines: DiffLine[], keep: DiffLine["type"]): SideText {
	const parts: string[] = [];
	const starts: number[] = [];
	const lineIndexes: number[] = [];
	let offset = 0;
	lines.forEach((line, index) => {
		if (line.type !== "context" && line.type !== keep) return;
		starts.push(offset);
		lineIndexes.push(index);
		parts.push(line.content);
		offset += line.content.length + 1;
	});
	return { text: parts.join("\n"), starts, lineIndexes };
}

/** Index of the last line starting at or before `offset`. */
function lineAt(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= offset) low = mid;
		else high = mid - 1;
	}
	return low;
}

function highlightSide(
	side: SideText,
	parser: Parser,
	into: Map<number, SyntaxToken[]>,
	accept: (line: DiffLine) => boolean,
	lines: DiffLine[],
): void {
	if (side.starts.length === 0) return;
	const tree = parser.parse(side.text);
	highlightTree(tree, highlighters, (from, to, className) => {
		// A token can span lines (block comment, multi-line string).
		for (let k = lineAt(side.starts, from); k < side.starts.length; k++) {
			const start = side.starts[k];
			if (start >= to) break;
			const index = side.lineIndexes[k];
			const line = lines[index];
			const lineEnd = start + line.content.length;
			const a = Math.max(from, start) - start;
			const b = Math.min(to, lineEnd) - start;
			if (b > a && accept(line)) {
				let tokens = into.get(index);
				if (!tokens) {
					tokens = [];
					into.set(index, tokens);
				}
				tokens.push({ from: a, to: b, className });
			}
		}
	});
}

/**
 * The syntax tokens of every diff line (by index in `lines`). Context lines
 * take their colours from the new side, removed lines from the old side.
 */
export function highlightDiffLines(
	lines: DiffLine[],
	parser: Parser,
): Map<number, SyntaxToken[]> {
	const tokens = new Map<number, SyntaxToken[]>();
	highlightSide(
		buildSide(lines, "removed"),
		parser,
		tokens,
		(line) => line.type === "removed",
		lines,
	);
	highlightSide(buildSide(lines, "added"), parser, tokens, () => true, lines);
	return tokens;
}

/**
 * Syntax tokens for a parsed patch, once the grammar of `path` is loaded
 * (lazily, cached for the session). Empty while loading, for an unknown
 * language, or for a patch too large to parse.
 */
export function useDiffSyntax(
	lines: DiffLine[],
	path: string | undefined,
	size: number,
): Map<number, SyntaxToken[]> | null {
	const [parser, setParser] = useState<{ path: string; parser: Parser } | null>(
		null,
	);

	useEffect(() => {
		if (!path || size > MAX_HIGHLIGHT_CHARS) return;
		const description = findLanguage(path);
		if (!description) return;
		let cancelled = false;
		loadLanguage(description).then((support) => {
			if (!cancelled && support) {
				setParser({ path, parser: support.language.parser });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [path, size]);

	return useMemo(() => {
		if (!parser || parser.path !== path || size > MAX_HIGHLIGHT_CHARS)
			return null;
		try {
			return highlightDiffLines(lines, parser.parser);
		} catch {
			// A grammar that throws on a fragment: show the diff uncoloured.
			return null;
		}
	}, [lines, parser, path, size]);
}
