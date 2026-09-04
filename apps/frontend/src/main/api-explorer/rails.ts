import path from "node:path";
import { readFile, walkFiles } from "./source-files";
import type { DetectedRoute } from "./types";

/**
 * Rails — `config/routes.rb`.
 *
 * The previous pass read one line at a time: it found `get 'health'` but not
 * the `namespace :api` two levels above it, and it expanded `resources` to
 * five hard-coded routes whatever `only:` said. A routes file is a nested DSL,
 * so this reads it as one — blocks, prefixes and all.
 */

const FRAMEWORK = "Rails";

/** Action → the verbs and the suffix Rails maps it to. */
const RESOURCE_ACTIONS: Record<string, { methods: string[]; suffix: string }> =
	{
		index: { methods: ["GET"], suffix: "" },
		create: { methods: ["POST"], suffix: "" },
		new: { methods: ["GET"], suffix: "/new" },
		show: { methods: ["GET"], suffix: "/{id}" },
		update: { methods: ["PATCH", "PUT"], suffix: "/{id}" },
		edit: { methods: ["GET"], suffix: "/{id}/edit" },
		destroy: { methods: ["DELETE"], suffix: "/{id}" },
	};

const PLURAL_DEFAULT = [
	"index",
	"create",
	"new",
	"show",
	"update",
	"edit",
	"destroy",
];
const SINGULAR_DEFAULT = ["create", "new", "show", "update", "edit", "destroy"];

const VERBS = ["get", "post", "put", "patch", "delete", "options", "head"];

export function toOpenApiPath(routePath: string): string {
	const normalized = routePath
		.replace(/\(\.:format\)/g, "")
		.replace(/:([A-Za-z_]\w*)/g, "{$1}")
		.replace(/\*([A-Za-z_]\w*)/g, "{$1}")
		.replace(/\/+/g, "/");
	const trimmed =
		normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
	return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed}`;
}

function joinPaths(...parts: string[]): string {
	return toOpenApiPath(
		`/${parts
			.map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
			.filter(Boolean)
			.join("/")}`,
	);
}

/**
 * Enough of an inflector for a nested route's foreign key: `posts` → `post_id`.
 * Rails uses a full one, and an irregular plural lands on a wrong parameter
 * name rather than on a wrong path — the shape of the route still holds.
 */
export function singularize(word: string): string {
	if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`;
	if (/(s|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
	if (/ss$/i.test(word)) return word;
	if (/s$/i.test(word)) return word.slice(0, -1);
	return word;
}

// ── Ruby block scanning ───────────────────────────────────────────────────────

/** Keywords that need an `end` when they open a line. */
const BLOCK_KEYWORDS = [
	"if",
	"unless",
	"case",
	"begin",
	"while",
	"until",
	"def",
	"class",
	"module",
];

function isWordChar(ch: string | undefined): boolean {
	return ch !== undefined && /[\w?!]/.test(ch);
}

/** True when the token at `index` is the first thing on its line. */
function startsLine(source: string, index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		const ch = source[i];
		if (ch === "\n") return true;
		if (ch !== " " && ch !== "\t") return false;
	}
	return true;
}

/** Index just past the string literal opened at `index`. */
function skipRubyString(source: string, index: number): number {
	const quote = source[index];
	for (let i = index + 1; i < source.length; i++) {
		if (source[i] === "\\") {
			i++;
			continue;
		}
		if (source[i] === quote) return i;
	}
	return source.length;
}

/**
 * The index of the `end` closing the block opened just before `from`.
 *
 * A modifier — `get :ping if Rails.env.test?` — takes no `end`, so a keyword
 * only opens a block when it starts its line. Counting it either way is what
 * makes a scanner swallow the rest of the file.
 */
export function findBlockEnd(source: string, from: number): number {
	let depth = 1;
	for (let i = from; i < source.length; i++) {
		const ch = source[i];
		if (ch === "#") {
			const eol = source.indexOf("\n", i);
			if (eol === -1) return source.length;
			i = eol;
			continue;
		}
		if (ch === '"' || ch === "'") {
			i = skipRubyString(source, i);
			continue;
		}
		if (!/[a-z]/.test(ch) || isWordChar(source[i - 1])) continue;
		const word = source.slice(i).match(/^[a-z]+/)?.[0] ?? "";
		if (isWordChar(source[i + word.length])) continue;
		if (word === "do" || (BLOCK_KEYWORDS.includes(word) && startsLine(source, i))) {
			depth++;
		} else if (word === "end") {
			depth--;
			if (depth === 0) return i;
		}
		i += word.length - 1;
	}
	return source.length;
}

interface Statement {
	/** The call and its arguments, without the block. */
	head: string;
	/** The block body, when the statement opens one. */
	body?: { start: number; end: number };
	/** Where the next statement begins. */
	next: number;
}

/** Reads one statement of a routes file, block included. */
function readStatement(
	source: string,
	from: number,
	limit: number,
): Statement | null {
	let i = from;
	while (i < limit && /\s/.test(source[i])) i++;
	if (i >= limit) return null;
	if (source[i] === "#") {
		const eol = source.indexOf("\n", i);
		return { head: "", next: eol === -1 ? limit : eol + 1 };
	}

	const start = i;
	let depth = 0;
	for (; i < limit; i++) {
		const ch = source[i];
		if (ch === "#") {
			const eol = source.indexOf("\n", i);
			i = eol === -1 ? limit : eol;
			continue;
		}
		if (ch === '"' || ch === "'") {
			i = skipRubyString(source, i);
			continue;
		}
		if ("([".includes(ch)) depth++;
		else if (")]".includes(ch)) depth--;
		else if (ch === "{" && depth === 0 && opensBlock(source, i)) {
			const end = findBraceEnd(source, i + 1);
			return {
				head: source.slice(start, i),
				body: { start: i + 1, end },
				next: end + 1,
			};
		} else if (ch === "{") depth++;
		else if (ch === "}") depth--;
		else if (ch === "\n" && depth === 0) {
			const head = source.slice(start, i);
			// A trailing comma or operator means the call continues below.
			if (/[,+\\|(&]\s*$/.test(head)) continue;
			return { head, next: i + 1 };
		} else if (
			depth === 0 &&
			ch === "d" &&
			source.startsWith("do", i) &&
			!isWordChar(source[i - 1]) &&
			!isWordChar(source[i + 2])
		) {
			const end = findBlockEnd(source, i + 2);
			return {
				head: source.slice(start, i),
				body: { start: i + 2, end },
				next: end + 3,
			};
		}
	}
	return { head: source.slice(start, limit), next: limit };
}

/** A `{` opens a block unless it opens a hash argument. */
function opensBlock(source: string, index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		const ch = source[i];
		if (/\s/.test(ch)) continue;
		return !",:=>([{".includes(ch);
	}
	return false;
}

function findBraceEnd(source: string, from: number): number {
	let depth = 1;
	for (let i = from; i < source.length; i++) {
		const ch = source[i];
		if (ch === "#") {
			const eol = source.indexOf("\n", i);
			i = eol === -1 ? source.length : eol;
			continue;
		}
		if (ch === '"' || ch === "'") {
			i = skipRubyString(source, i);
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
	}
	return source.length;
}

// ── Argument reading ──────────────────────────────────────────────────────────

/** The arguments of a call, split on the commas that separate them. */
function splitArguments(head: string): string[] {
	const args = head.replace(/^\s*\w+\s*\(?/, "");
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (ch === '"' || ch === "'") {
			i = skipRubyString(args, i);
			continue;
		}
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		else if (ch === "," && depth === 0) {
			parts.push(args.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(args.slice(start));
	return parts;
}

/**
 * The names a `resources`/`resource` line declares.
 *
 * They are the positional arguments only: reading every `:symbol` of the line
 * turns `only: [:index]` into a resource called `index`, which is how a route
 * file ends up reporting `GET /index`.
 */
function positionalNames(head: string): string[] {
	const names: string[] = [];
	for (const part of splitArguments(head)) {
		const trimmed = part.trim();
		const name =
			trimmed.match(/^:([A-Za-z_]\w*)$/)?.[1] ??
			trimmed.match(/^["']([^"']*)["']$/)?.[1];
		// The first option ends the positional list.
		if (name === undefined) break;
		names.push(name);
	}
	return names;
}

/** The first positional argument, as a string or a symbol. */
function firstArgument(head: string): string | undefined {
	const body = head.replace(/^\s*\w+\s*\(?/, "");
	return (
		body.match(/^\s*["']([^"']*)["']/)?.[1] ??
		body.match(/^\s*:([A-Za-z_]\w*)/)?.[1]
	);
}

function option(head: string, name: string): string | undefined {
	const value = head.match(
		new RegExp(`\\b${name}\\s*:\\s*(?:["']([^"']*)["']|:([A-Za-z_]\\w*))`),
	);
	return value ? (value[1] ?? value[2]) : undefined;
}

/** `only: %i[index show]`, `only: [:index, :show]`, `only: :index`. */
function actionList(head: string, name: string): string[] | undefined {
	const list = head.match(new RegExp(`\\b${name}\\s*:\\s*(%i|%w)?\\[([^\\]]*)\\]`));
	if (list) {
		return list[2]
			.split(/[\s,]+/)
			.map((entry) => entry.replace(/^:/, "").trim())
			.filter(Boolean);
	}
	const single = head.match(new RegExp(`\\b${name}\\s*:\\s*:([A-Za-z_]\\w*)`));
	return single ? [single[1]] : undefined;
}

/** `via: [:get, :post]` on a `match`. */
function viaMethods(head: string): string[] {
	const list = actionList(head, "via");
	if (!list) return ["GET"];
	if (list.includes("all")) return ["GET", "POST", "PUT", "PATCH", "DELETE"];
	return list.map((verb) => verb.toUpperCase());
}

// ── Walking the DSL ───────────────────────────────────────────────────────────

interface Frame {
	/** The path everything in this block hangs from. */
	prefix: string;
	/** The resource whose block this is, for `member` and `collection`. */
	resource?: { collectionPath: string; memberPath: string; tag: string };
	tag: string;
}

interface Context {
	source: string;
	file: string;
	routes: DetectedRoute[];
	/** `config.api_only` — Rails then maps no `new` and no `edit`. */
	apiOnly: boolean;
}

function push(
	context: Context,
	routePath: string,
	methods: string[],
	tag: string,
	summary?: string,
) {
	context.routes.push({
		path: routePath,
		methods,
		tag,
		file: context.file,
		framework: FRAMEWORK,
		requiresAuth: false,
		...(summary ? { summary } : {}),
	});
}

function resourceActions(
	head: string,
	singular: boolean,
	apiOnly: boolean,
): string[] {
	const base = singular ? SINGULAR_DEFAULT : PLURAL_DEFAULT;
	const only = actionList(head, "only");
	if (only) return only.filter((action) => action in RESOURCE_ACTIONS);
	const except = actionList(head, "except") ?? [];
	const skipped = apiOnly ? [...except, "new", "edit"] : except;
	return base.filter((action) => !skipped.includes(action));
}

function walk(context: Context, start: number, end: number, frame: Frame) {
	let cursor = start;
	while (cursor < end) {
		const statement = readStatement(context.source, cursor, end);
		if (!statement) return;
		cursor = statement.next;
		const head = statement.head.trim();
		if (!head) continue;
		const call = head.match(/^([a-z_]\w*)/)?.[1];
		if (!call) continue;

		if (call === "namespace" || call === "scope") {
			const declared =
				call === "namespace"
					? (option(head, "path") ?? firstArgument(head))
					: (option(head, "path") ??
						(/^scope\s*\(?\s*["':]/.test(head) ? firstArgument(head) : ""));
			const prefix = joinPaths(frame.prefix, declared ?? "");
			if (statement.body) {
				walk(context, statement.body.start, statement.body.end, {
					prefix,
					tag: declared || frame.tag,
				});
			}
			continue;
		}

		if (call === "resources" || call === "resource") {
			readResource(context, head, statement, frame, call === "resource");
			continue;
		}

		if (call === "member" || call === "collection") {
			if (!statement.body || !frame.resource) continue;
			walk(context, statement.body.start, statement.body.end, {
				prefix:
					call === "member"
						? frame.resource.memberPath
						: frame.resource.collectionPath,
				tag: frame.resource.tag,
			});
			continue;
		}

		if (call === "root") {
			const target = option(head, "to") ?? firstArgument(head);
			push(context, joinPaths(frame.prefix), ["GET"], frame.tag, target);
			continue;
		}

		if (VERBS.includes(call) || call === "match") {
			const declared = firstArgument(head) ?? "";
			const target = option(head, "to") ?? head.match(/=>\s*["']([^"']+)["']/)?.[1];
			const methods = call === "match" ? viaMethods(head) : [call.toUpperCase()];
			push(
				context,
				joinPaths(frame.prefix, declared),
				methods,
				target?.split("#")[0] ?? frame.tag,
				target,
			);
			continue;
		}

		// `constraints`, `defaults`, `concerns`, `if` — they wrap routes without
		// moving them, so their body is read at the same prefix. `mount` is left
		// out on purpose: an engine is not an endpoint of this application.
		if (statement.body && call !== "mount" && call !== "concern") {
			walk(context, statement.body.start, statement.body.end, frame);
		}
	}
}

function readResource(
	context: Context,
	head: string,
	statement: Statement,
	frame: Frame,
	singular: boolean,
) {
	// `resources :posts, :comments` declares both.
	const declared = positionalNames(head);
	const pathOverride = option(head, "path");

	for (const name of declared) {
		if (!name) continue;
		const collectionPath = joinPaths(frame.prefix, pathOverride ?? name);
		const memberPath = singular
			? collectionPath
			: joinPaths(collectionPath, "{id}");

		for (const action of resourceActions(head, singular, context.apiOnly)) {
			const mapped = RESOURCE_ACTIONS[action];
			const suffix = singular ? mapped.suffix.replace("/{id}", "") : mapped.suffix;
			push(
				context,
				joinPaths(collectionPath, suffix),
				mapped.methods,
				name,
				`${name}#${action}`,
			);
		}

		if (!statement.body) continue;
		walk(context, statement.body.start, statement.body.end, {
			// Anything declared inside the block hangs off one record.
			prefix: singular
				? collectionPath
				: joinPaths(collectionPath, `{${singularize(name)}_id}`),
			tag: name,
			resource: { collectionPath, memberPath, tag: name },
		});
	}
}

// ── Entry point ───────────────────────────────────────────────────────────────

/** `config.api_only = true` — Rails then maps no `new` and no `edit` action. */
function isApiOnly(projectPath: string): boolean {
	for (const file of walkFiles(projectPath, ["application.rb"], 4)) {
		const content = readFile(file);
		if (content && /config\.api_only\s*=\s*true/.test(content)) return true;
	}
	return false;
}

export function detectRails(projectPath: string): DetectedRoute[] {
	const files = walkFiles(projectPath, ["routes.rb"]);
	if (files.length === 0) return [];
	const apiOnly = isApiOnly(projectPath);
	const routes: DetectedRoute[] = [];

	for (const file of files) {
		const content = readFile(file);
		if (!content) continue;
		const context: Context = {
			source: content,
			file: path.relative(projectPath, file),
			routes,
			apiOnly,
		};
		// Everything lives inside `routes.draw do … end`; a file that does not
		// open one is read whole, so a partial extracted with `draw(:admin)`
		// still reports its routes.
		const draw = content.match(/routes\s*\.\s*draw\s*(?:\([^)]*\)\s*)?do/);
		const start = draw?.index === undefined ? 0 : draw.index + draw[0].length;
		const end = start > 0 ? findBlockEnd(content, start) : content.length;
		walk(context, start, end, { prefix: "", tag: "routes" });
	}
	return routes;
}
