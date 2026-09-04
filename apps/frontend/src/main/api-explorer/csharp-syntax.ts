/**
 * Small, string- and comment-aware scanning primitives for C# source text.
 *
 * The API Explorer scan reads source rather than compiling it, so the goal
 * here is not a parser: it is to stop regexes from tripping over the three
 * things that actually break them in real controllers — braces inside string
 * literals, commas inside generic arguments, and attributes split over
 * several lines.
 */

/**
 * Options for the scanners below, so one implementation serves more than one
 * language.
 */
export interface ScanOptions {
	/**
	 * Treat a backtick as a string delimiter. Off for C#, on for JS and TS,
	 * where a template literal may hold braces that must not be counted.
	 */
	templateLiterals?: boolean;
	/**
	 * Read `'` as a char literal only when it closes right away (`'x'`, `'\n'`).
	 * On for Rust: `&'static str` is a lifetime, and reading it as an
	 * unterminated literal swallows the rest of the line — braces included.
	 */
	lifetimes?: boolean;
}

/** True when `'` at `index` opens a char literal rather than a lifetime. */
export function isCharLiteral(source: string, index: number): boolean {
	return /^'(?:\\.|[^\\'])'/.test(source.slice(index, index + 4));
}

/** Index of the closing quote of the literal that starts at `index`. */
export function skipStringLiteral(source: string, index: number): number {
	if (source.startsWith('"""', index)) {
		const end = source.indexOf('"""', index + 3);
		return end === -1 ? source.length : end + 2;
	}
	// `@"..."`, `$@"..."` and `@$"..."` double their quotes instead of
	// escaping them with a backslash.
	let prefixStart = index;
	while (prefixStart > 0 && "@$".includes(source[prefixStart - 1])) prefixStart--;
	const verbatim = source.slice(prefixStart, index).includes("@");
	const quote = source[index];
	// A template literal ends on its backtick; `\n` inside it is legal, so the
	// newline bail-out below must not apply.
	const isTemplate = quote === "`";
	for (let i = index + 1; i < source.length; i++) {
		const ch = source[i];
		if (verbatim) {
			if (ch === quote) {
				if (source[i + 1] === quote) {
					i++;
					continue;
				}
				return i;
			}
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === quote) return i;
		if (ch === "\n" && !isTemplate) return i;
	}
	return source.length;
}

/**
 * Index of the character that closes the token opened at `openIndex`, or the
 * end of the source when the file is truncated or unbalanced.
 */
export function findMatching(
	source: string,
	openIndex: number,
	open: string,
	close: string,
	options: ScanOptions = {},
): number {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "/" && source[i + 1] === "/") {
			const eol = source.indexOf("\n", i);
			if (eol === -1) return source.length;
			i = eol;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if (ch === "'" && options.lifetimes && !isCharLiteral(source, i)) continue;
		if (ch === '"' || ch === "'" || (options.templateLiterals && ch === "`")) {
			i = skipStringLiteral(source, i);
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return source.length;
}

/** Index of the `;` that ends the statement starting at `startIndex`. */
export function findStatementEnd(
	source: string,
	startIndex: number,
	options: ScanOptions = {},
): number {
	let parens = 0;
	let braces = 0;
	for (let i = startIndex; i < source.length; i++) {
		const ch = source[i];
		if (ch === "/" && source[i + 1] === "/") {
			const eol = source.indexOf("\n", i);
			if (eol === -1) return source.length;
			i = eol;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if (ch === "'" && options.lifetimes && !isCharLiteral(source, i)) continue;
		if (ch === '"' || ch === "'" || (options.templateLiterals && ch === "`")) {
			i = skipStringLiteral(source, i);
			continue;
		}
		if (ch === "(") parens++;
		else if (ch === ")") parens--;
		else if (ch === "{") braces++;
		else if (ch === "}") braces--;
		else if (ch === ";" && parens <= 0 && braces <= 0) return i;
	}
	return source.length;
}

/** Splits on `separator` while ignoring nested brackets and string literals. */
export function splitTopLevel(
	text: string,
	separator = ",",
	options: ScanOptions = {},
): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"' || ch === "'" || (options.templateLiterals && ch === "`")) {
			i = skipStringLiteral(text, i);
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
		else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
		else if (ch === separator && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export interface Annotations {
	/** Each attribute as written, without its enclosing brackets. */
	attributes: string[];
	/** The XML documentation comment above the declaration, `///` stripped. */
	doc: string;
}

const EMPTY_ANNOTATIONS: Annotations = { attributes: [], doc: "" };

/**
 * Reads the attribute list and XML doc comment that precede the declaration
 * starting at `declStart`.
 *
 * Attributes split over several lines are kept: the walk continues while the
 * text collected so far still has an unclosed `[`.
 */
export function collectAnnotations(
	source: string,
	declStart: number,
): Annotations {
	const before = source.slice(0, declStart);
	const lines = before.split("\n");
	// Drop the declaration's own line: it is not part of what precedes it.
	lines.pop();

	const collected: string[] = [];
	// Unmatched `]` seen so far while walking upwards: while it is positive we
	// are inside an attribute whose opening bracket is on an earlier line.
	let openAbove = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const trimmed = line.trim();
		const balance =
			(line.match(/\]/g)?.length ?? 0) - (line.match(/\[/g)?.length ?? 0);
		const isAnnotation =
			trimmed.startsWith("[") ||
			trimmed.startsWith("///") ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*");

		if (openAbove <= 0 && !isAnnotation && balance <= 0) break;

		collected.unshift(line);
		openAbove = Math.max(0, openAbove + balance);
	}
	if (collected.length === 0) return EMPTY_ANNOTATIONS;

	const blob = collected.join("\n");
	const doc = collected
		.filter((line) => line.trim().startsWith("///"))
		.map((line) => line.trim().replace(/^\/\/\/\s?/, ""))
		.join("\n");

	const attributes: string[] = [];
	for (let i = 0; i < blob.length; i++) {
		const ch = blob[i];
		if (ch === '"' || ch === "'") {
			i = skipStringLiteral(blob, i);
			continue;
		}
		if (ch !== "[") continue;
		const end = findMatching(blob, i, "[", "]");
		const inner = blob.slice(i + 1, end);
		// `[Foo, Bar]` is a single bracket holding two attributes.
		for (const attribute of splitTopLevel(inner)) attributes.push(attribute);
		i = end;
	}
	return { attributes, doc };
}

export interface XmlDoc {
	summary?: string;
	description?: string;
	params: Record<string, string>;
}

/** Reads `<summary>`, `<remarks>` and `<param>` out of an XML doc comment. */
export function parseXmlDoc(doc: string): XmlDoc {
	const params: Record<string, string> = {};
	if (!doc) return { params };

	const normalize = (text: string): string =>
		text
			.replace(/<see\s+cref="[^"]*?([\w.]+)"\s*\/>/g, "$1")
			.replace(/<[^>]+>/g, " ")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

	const summaryMatch = doc.match(/<summary>([\s\S]*?)<\/summary>/);
	const remarksMatch = doc.match(/<remarks>([\s\S]*?)<\/remarks>/);
	const paramRe = /<param\s+name="(\w+)"\s*>([\s\S]*?)<\/param>/g;
	let paramMatch: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((paramMatch = paramRe.exec(doc)) !== null) {
		const text = normalize(paramMatch[2]);
		if (text) params[paramMatch[1]] = text;
	}

	return {
		summary: summaryMatch ? normalize(summaryMatch[1]) || undefined : undefined,
		description: remarksMatch
			? normalize(remarksMatch[1]) || undefined
			: undefined,
		params,
	};
}

/** The name of an attribute, without namespace, generics or `Attribute` suffix. */
export function attributeName(attribute: string): string {
	const head = attribute.split("(")[0].split("<")[0].trim();
	const short = head.split(".").pop() ?? head;
	return short.replace(/Attribute$/, "");
}

/** The argument text of an attribute, or `""` when it has no argument list. */
export function attributeArguments(attribute: string): string {
	const open = attribute.indexOf("(");
	if (open === -1) return "";
	const end = findMatching(attribute, open, "(", ")");
	return attribute.slice(open + 1, end);
}

/** The generic argument of `[Foo<Bar>(...)]`, or `undefined`. */
export function attributeGenericArgument(
	attribute: string,
): string | undefined {
	const head = attribute.split("(")[0];
	const match = head.match(/<([^>]+)>/);
	return match ? match[1].trim() : undefined;
}

/** Removes the quotes of a C# string literal, verbatim prefix included. */
export function unquote(text: string): string {
	const trimmed = text.trim().replace(/^[@$]+/, "");
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return trimmed.slice(1, -1).replace(/""/g, '"');
	}
	return trimmed;
}

/** Every string literal in `text`, in order. */
export function stringLiterals(text: string): string[] {
	const literals: string[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '"') continue;
		const end = skipStringLiteral(text, i);
		literals.push(unquote(text.slice(i, end + 1)));
		i = end;
	}
	return literals;
}
