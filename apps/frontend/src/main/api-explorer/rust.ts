import path from "node:path";
import { findMatching, findStatementEnd } from "./csharp-syntax";
import { readFile, walkFiles } from "./source-files";
import type { DetectedRoute } from "./types";

/**
 * Axum and Actix Web.
 *
 * The previous pass matched `.route("/x", get(...))` one line at a time, which
 * reports `/users` for a route served at `/api/v1/users`: in Axum the base path
 * lives in `.nest()`, on a router the handler's own line never mentions. It
 * also stopped at the first verb, so `.route("/x", get(a).post(b))` lost the
 * POST, and it matched nothing at all in Actix, whose `.route` takes
 * `web::get()` rather than a bare verb.
 */

const SCAN = { lifetimes: true } as const;

const AXUM = "Rust/Axum";
const ACTIX = "Rust/Actix";

const VERBS = ["get", "post", "put", "delete", "patch", "head", "options"];

/** Axum 0.6 writes `:id` and `*rest`; 0.8 writes `{id}` and `{*rest}`. */
export function toOpenApiPath(routePath: string): string {
	const normalized = routePath
		.replace(/\{\*([A-Za-z_]\w*)\}/g, "{$1}")
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

/** The first string literal in `text`, which is where every router puts its path. */
function firstLiteral(text: string): string | undefined {
	return text.match(/"((?:[^"\\]|\\.)*)"/)?.[1];
}

/**
 * The end of the method chain that starts at `index`, following `.name(…)`
 * links across whitespace and newlines.
 *
 * Both frameworks express nesting as a chain rather than as a block, so the
 * chain *is* the scope: everything `web::scope("/api")` serves is written to
 * its right, and stops at the first token that is not another link.
 */
function chainEnd(source: string, index: number): number {
	let cursor = index;
	for (;;) {
		const rest = source.slice(cursor);
		const link = rest.match(/^\s*\.\s*\w+\s*(?=\()/);
		if (!link) return cursor;
		const open = source.indexOf("(", cursor + link[0].length - 1);
		if (open === -1) return cursor;
		cursor = findMatching(source, open, "(", ")", SCAN) + 1;
	}
}

/** The `.name(...)` links of a chain, as `[name, argument text]` pairs. */
function chainLinks(
	source: string,
	start: number,
	end: number,
): Array<{ name: string; args: string; start: number; end: number }> {
	const links: Array<{
		name: string;
		args: string;
		start: number;
		end: number;
	}> = [];
	let cursor = start;
	while (cursor < end) {
		const link = source.slice(cursor, end).match(/^\s*\.\s*(\w+)\s*(?=\()/);
		if (!link) break;
		const open = source.indexOf("(", cursor + link[0].length - 1);
		if (open === -1 || open >= end) break;
		const close = findMatching(source, open, "(", ")", SCAN);
		links.push({
			name: link[1],
			args: source.slice(open + 1, close),
			start: open + 1,
			end: close,
		});
		cursor = close + 1;
	}
	return links;
}

// ── Axum ──────────────────────────────────────────────────────────────────────

interface RouterRef {
	/** The module qualifying the reference, when it carries one. */
	module: string | null;
	name: string;
}

interface RouterScope {
	key: string;
	module: string;
	name: string | null;
	file: string;
	start: number;
	end: number;
	routes: Array<{ path: string; methods: string[] }>;
	children: Array<{ prefix: string; ref: RouterRef }>;
}

/** The verbs a `MethodRouter` expression registers. */
function methodsOf(handler: string): string[] {
	const methods = new Set<string>();
	// `(?<![\w:])` keeps Actix out: its `.route("/x", web::get().to(h))` would
	// otherwise read as an Axum `get(...)`, and the same route would be
	// reported twice — once with its scope prefix and once without.
	for (const match of handler.matchAll(
		new RegExp(`(?<![\\w:])(${VERBS.join("|")})\\s*\\(`, "g"),
	)) {
		methods.add(match[1].toUpperCase());
	}
	for (const match of handler.matchAll(/MethodFilter::([A-Z]+)/g)) {
		methods.add(match[1]);
	}
	// `any(handler)` serves every verb. Listing five operations for one
	// catch-all reads as five endpoints, so it is reported as the GET a
	// browser or a probe would actually reach for.
	if (methods.size === 0 && /\bany\s*\(/.test(handler)) methods.add("GET");
	return [...methods];
}

/** `crate::api::users::routes()` → the module and function that name it. */
function parseRef(expression: string): RouterRef | null {
	const trimmed = expression.trim().replace(/\(\s*\)\s*$/, "");
	const segments = trimmed.match(/^[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*$/)
		? trimmed.split("::").map((segment) => segment.trim())
		: null;
	if (!segments || segments.length === 0) return null;
	const name = segments[segments.length - 1];
	const module = segments.length > 1 ? segments[segments.length - 2] : null;
	return { module, name };
}

/** Every router-valued function and `let` binding in one file. */
function scopesIn(
	content: string,
	file: string,
	module: string,
): RouterScope[] {
	const scopes: RouterScope[] = [];
	const make = (
		name: string | null,
		start: number,
		end: number,
	): RouterScope => ({
		key: `${file}#${scopes.length}`,
		module,
		name,
		file,
		start,
		end,
		routes: [],
		children: [],
	});

	// `fn routes() -> Router { … }` — the shape every module that owns a slice
	// of the API exposes, and the one `.nest()` refers to from elsewhere.
	for (const match of content.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*(?=[(<])/g)) {
		const paren = content.indexOf("(", match.index);
		if (paren === -1) continue;
		const close = findMatching(content, paren, "(", ")", SCAN);
		const brace = content.indexOf("{", close);
		if (brace === -1) continue;
		if (!/\bRouter\b/.test(content.slice(close, brace))) continue;
		scopes.push(make(match[1], brace, findMatching(content, brace, "{", "}", SCAN)));
	}

	for (const match of content.matchAll(
		/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::[^=;]*)?=/g,
	)) {
		const start = match.index + match[0].length;
		const end = findStatementEnd(content, start, SCAN);
		if (!/Router\s*::\s*new|Router\s*::\s*<|\bRouter\b/.test(content.slice(start, end))) {
			continue;
		}
		scopes.push(make(match[1], start, end));
	}

	// Everything outside a named scope still belongs somewhere: a router built
	// inline inside `serve(…)` has no name to nest under, and dropping it would
	// lose the routes of the smallest programs there are.
	scopes.push(make(null, 0, content.length));
	return scopes;
}

function innermost(scopes: RouterScope[], index: number): RouterScope {
	let best = scopes[scopes.length - 1];
	for (const scope of scopes) {
		if (index <= scope.start || index >= scope.end) continue;
		if (scope.end - scope.start < best.end - best.start) best = scope;
	}
	return best;
}

export function detectAxum(
	sources: Array<{ file: string; relativePath: string; content: string }>,
): DetectedRoute[] {
	const scopes: RouterScope[] = [];
	for (const source of sources) {
		const module = path.basename(source.file).replace(/\.rs$/, "");
		const fileScopes = scopesIn(source.content, source.relativePath, module);
		for (const link of collectAxumLinks(source.content)) {
			const owner = innermost(fileScopes, link.index);
			if (link.kind === "route") owner.routes.push(link.route);
			else owner.children.push(link.child);
		}
		scopes.push(...fileScopes);
	}

	const byQualified = new Map<string, RouterScope>();
	const byName = new Map<string, RouterScope[]>();
	for (const scope of scopes) {
		if (!scope.name) continue;
		byQualified.set(`${scope.module}::${scope.name}`, scope);
		byName.set(scope.name, [...(byName.get(scope.name) ?? []), scope]);
	}

	const resolve = (ref: RouterRef, from: RouterScope): RouterScope | null => {
		if (ref.module) return byQualified.get(`${ref.module}::${ref.name}`) ?? null;
		const sameFile = byName
			.get(ref.name)
			?.find((scope) => scope.file === from.file);
		const candidates = byName.get(ref.name) ?? [];
		// An unqualified name is resolved in its own file first; across files it
		// is only trusted when exactly one module answers to it, because
		// `routes()` is what every module calls its router.
		return sameFile ?? (candidates.length === 1 ? candidates[0] : null);
	};

	const referenced = new Set<string>();
	for (const scope of scopes) {
		for (const child of scope.children) {
			const target = resolve(child.ref, scope);
			if (target && target !== scope) referenced.add(target.key);
		}
	}

	const routes: DetectedRoute[] = [];
	const emit = (scope: RouterScope, prefix: string, seen: Set<string>) => {
		if (seen.has(scope.key)) return;
		const visited = new Set(seen).add(scope.key);
		for (const route of scope.routes) {
			routes.push({
				path: joinPaths(prefix, route.path),
				methods: route.methods,
				tag: scope.module,
				file: scope.file,
				framework: AXUM,
				requiresAuth: false,
			});
		}
		for (const child of scope.children) {
			const target = resolve(child.ref, scope);
			if (target) emit(target, joinPaths(prefix, child.prefix), visited);
		}
	};

	for (const scope of scopes) {
		if (!referenced.has(scope.key)) emit(scope, "", new Set());
	}
	return routes;
}

type AxumLink =
	| { kind: "route"; index: number; route: { path: string; methods: string[] } }
	| { kind: "child"; index: number; child: { prefix: string; ref: RouterRef } };

function collectAxumLinks(content: string): AxumLink[] {
	const links: AxumLink[] = [];
	for (const match of content.matchAll(
		/\.\s*(route|nest|nest_service|merge)\s*(?=\()/g,
	)) {
		const open = content.indexOf("(", match.index);
		if (open === -1) continue;
		const args = content.slice(
			open + 1,
			findMatching(content, open, "(", ")", SCAN),
		);
		const comma = splitFirstArgument(args);
		if (match[1] === "merge") {
			const ref = parseRef(args);
			if (ref) links.push({ kind: "child", index: match.index, child: { prefix: "", ref } });
			continue;
		}
		const routePath = firstLiteral(comma.head);
		if (routePath === undefined) continue;
		if (match[1] === "route") {
			const methods = methodsOf(comma.tail);
			if (methods.length > 0) {
				links.push({
					kind: "route",
					index: match.index,
					route: { path: routePath, methods },
				});
			}
			continue;
		}
		// `nest_service` mounts a file server or a tower service, not an API.
		if (match[1] === "nest_service") continue;
		const ref = parseRef(comma.tail);
		if (ref) {
			links.push({
				kind: "child",
				index: match.index,
				child: { prefix: routePath, ref },
			});
		}
	}
	return links;
}

/** Splits `"/x", get(h)` at the comma that separates the two arguments. */
function splitFirstArgument(args: string): { head: string; tail: string } {
	let depth = 0;
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (ch === '"') {
			i = skipRustString(args, i);
			continue;
		}
		if ("([{<".includes(ch)) depth++;
		else if (")]}>".includes(ch)) depth--;
		else if (ch === "," && depth === 0) {
			return { head: args.slice(0, i), tail: args.slice(i + 1) };
		}
	}
	return { head: args, tail: "" };
}

function skipRustString(source: string, index: number): number {
	for (let i = index + 1; i < source.length; i++) {
		if (source[i] === "\\") {
			i++;
			continue;
		}
		if (source[i] === '"') return i;
	}
	return source.length;
}

// ── Actix Web ─────────────────────────────────────────────────────────────────

/**
 * `#[get("/users/{id}")] async fn show(…)` — the handler declares its own path
 * and is mounted by name, so the two halves have to be read together.
 */
function macroRoutes(
	content: string,
): Map<string, Array<{ path: string; methods: string[] }>> {
	const byHandler = new Map<string, Array<{ path: string; methods: string[] }>>();
	const re = new RegExp(
		`#\\[\\s*(${VERBS.join("|")})\\s*\\(\\s*"([^"]*)"[^\\]]*\\]([\\s\\S]{0,400}?)\\bfn\\s+([A-Za-z_]\\w*)`,
		"g",
	);
	for (const match of content.matchAll(re)) {
		// Only the attributes of this handler may sit between the two.
		if (/\bfn\b|\bstruct\b|\bimpl\b/.test(match[3].replace(/#\[[^\]]*\]/g, ""))) {
			continue;
		}
		const handler = match[4];
		byHandler.set(handler, [
			...(byHandler.get(handler) ?? []),
			{ path: match[2], methods: [match[1].toUpperCase()] },
		]);
	}
	return byHandler;
}

/** `web::get()` / `web::method(Method::PUT)` inside a `.route(…)` argument. */
function actixMethods(args: string): string[] {
	const methods = new Set<string>();
	for (const match of args.matchAll(
		new RegExp(`web\\s*::\\s*(${VERBS.join("|")})\\s*\\(`, "g"),
	)) {
		methods.add(match[1].toUpperCase());
	}
	for (const match of args.matchAll(/Method::([A-Z]+)/g)) methods.add(match[1]);
	return [...methods];
}

interface ActixContext {
	content: string;
	relativePath: string;
	module: string;
	handlers: Map<string, Array<{ path: string; methods: string[] }>>;
	configs: Map<string, { start: number; end: number }>;
	routes: DetectedRoute[];
	seen: Set<string>;
}

function emitActix(
	context: ActixContext,
	prefix: string,
	routePath: string,
	methods: string[],
) {
	if (methods.length === 0) return;
	context.routes.push({
		path: joinPaths(prefix, routePath),
		methods,
		tag: context.module,
		file: context.relativePath,
		framework: ACTIX,
		requiresAuth: false,
	});
}

/** Reads one `.service(…)/.route(…)/.configure(…)` chain under `prefix`. */
function readActixChain(
	context: ActixContext,
	start: number,
	end: number,
	prefix: string,
) {
	for (const link of chainLinks(context.content, start, end)) {
		if (link.name === "route") {
			const { head, tail } = splitFirstArgument(link.args);
			const routePath = firstLiteral(head);
			if (routePath !== undefined) {
				emitActix(context, prefix, routePath, actixMethods(tail));
			}
			continue;
		}
		if (link.name === "configure") {
			const ref = parseRef(link.args);
			const config = ref ? context.configs.get(ref.name) : undefined;
			if (config && !context.seen.has(`${config.start}`)) {
				context.seen.add(`${config.start}`);
				readActixServices(context, config.start, config.end, prefix);
				context.seen.delete(`${config.start}`);
			}
			continue;
		}
		if (link.name !== "service") continue;
		readActixService(context, link.args, link.start, prefix);
	}
}

/** The body of one `.service(argument)`. */
function readActixService(
	context: ActixContext,
	args: string,
	argsStart: number,
	prefix: string,
) {
	const scope = args.match(/web\s*::\s*scope\s*(?=\()/);
	if (scope?.index !== undefined) {
		const open = context.content.indexOf("(", argsStart + scope.index);
		const close = findMatching(context.content, open, "(", ")", SCAN);
		const scopePath =
			firstLiteral(context.content.slice(open + 1, close)) ?? "";
		readActixChain(
			context,
			close + 1,
			chainEnd(context.content, close + 1),
			joinPaths(prefix, scopePath),
		);
		return;
	}
	const resource = args.match(/web\s*::\s*resource\s*(?=\()/);
	if (resource?.index !== undefined) {
		const open = context.content.indexOf("(", argsStart + resource.index);
		const close = findMatching(context.content, open, "(", ")", SCAN);
		const resourcePath =
			firstLiteral(context.content.slice(open + 1, close)) ?? "";
		const chain = chainEnd(context.content, close + 1);
		for (const link of chainLinks(context.content, close + 1, chain)) {
			if (link.name !== "route") continue;
			emitActix(context, prefix, resourcePath, actixMethods(link.args));
		}
		return;
	}
	// `.service(show)` — a handler that carries its own `#[get("…")]`.
	const ref = parseRef(args);
	for (const route of (ref && context.handlers.get(ref.name)) ?? []) {
		emitActix(context, prefix, route.path, route.methods);
	}
}

/** `cfg.service(…)` / `cfg.route(…)` statements inside a config function. */
function readActixServices(
	context: ActixContext,
	start: number,
	end: number,
	prefix: string,
) {
	for (const match of context.content
		.slice(start, end)
		.matchAll(/\b\w+\s*(?=\.\s*(?:service|route)\s*\()/g)) {
		const at = start + match.index + match[0].length;
		readActixChain(context, at, chainEnd(context.content, at), prefix);
	}
}

export function detectActix(
	sources: Array<{ file: string; relativePath: string; content: string }>,
): DetectedRoute[] {
	const routes: DetectedRoute[] = [];
	for (const source of sources) {
		if (!/App\s*::\s*new|web\s*::\s*(scope|resource|ServiceConfig)|HttpServer/.test(
			source.content,
		)) {
			continue;
		}
		const handlers = macroRoutes(source.content);
		const configs = new Map<string, { start: number; end: number }>();
		for (const match of source.content.matchAll(
			/\bfn\s+([A-Za-z_]\w*)\s*(?=\()/g,
		)) {
			const paren = source.content.indexOf("(", match.index);
			const close = findMatching(source.content, paren, "(", ")", SCAN);
			if (!/ServiceConfig/.test(source.content.slice(paren, close))) continue;
			const brace = source.content.indexOf("{", close);
			if (brace === -1) continue;
			configs.set(match[1], {
				start: brace,
				end: findMatching(source.content, brace, "{", "}", SCAN),
			});
		}

		const context: ActixContext = {
			content: source.content,
			relativePath: source.relativePath,
			module: path.basename(source.file).replace(/\.rs$/, ""),
			handlers,
			configs,
			routes: [],
			seen: new Set(),
		};

		// `App::new()` is the root; a config function reached only through
		// `.configure(…)` is read from there, with its prefix.
		for (const match of source.content.matchAll(/App\s*::\s*new\s*(?=\()/g)) {
			const open = source.content.indexOf("(", match.index);
			const close = findMatching(source.content, open, "(", ")", SCAN);
			readActixChain(
				context,
				close + 1,
				chainEnd(source.content, close + 1),
				"",
			);
		}

		// A handler nobody mounts is still an endpoint the binary serves once it
		// is registered, and a project split across files registers elsewhere.
		if (context.routes.length === 0) {
			for (const [, declared] of handlers) {
				for (const route of declared) {
					emitActix(context, "", route.path, route.methods);
				}
			}
		}
		routes.push(...context.routes);
	}
	return routes;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function detectRust(projectPath: string): DetectedRoute[] {
	const sources: Array<{
		file: string;
		relativePath: string;
		content: string;
	}> = [];
	for (const file of walkFiles(projectPath, [".rs"])) {
		const content = readFile(file);
		if (content) {
			sources.push({
				file,
				relativePath: path.relative(projectPath, file),
				content,
			});
		}
	}
	return [...detectAxum(sources), ...detectActix(sources)];
}
