import path from "node:path";
import { findMatching, splitTopLevel } from "./csharp-syntax";
import { readFile, walkFiles } from "./source-files";
import type { DetectedRoute } from "./types";

/**
 * Express, Fastify and NestJS.
 *
 * The previous pass read one declaration at a time and reported the path
 * exactly as written there, which is almost never the path the framework
 * serves: `@Get(':id')` inside `@Controller('users')` answers on
 * `/users/:id`, and `router.get('/')` mounted with `app.use('/api', router)`
 * answers on `/api`. Both came out as `/`. A wrong path is worse than a
 * missing one — it is a request the explorer sends to nowhere.
 */

const SCAN: { templateLiterals: true } = { templateLiterals: true };

const NODE_EXTENSIONS = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];

const HTTP_DECORATORS = [
	"Get",
	"Post",
	"Put",
	"Delete",
	"Patch",
	"Head",
	"Options",
	"All",
] as const;

const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"head",
	"options",
] as const;

/** `:id` and `*rest` are how Express and Nest write what OpenAPI spells `{id}`. */
export function toOpenApiPath(routePath: string): string {
	const normalized = routePath
		.replace(/:([A-Za-z_$][\w$]*)\??/g, "{$1}")
		.replace(/\{([\w$]+)\}\*/g, "{$1}")
		.replace(/\/\*$/, "/{wildcard}")
		.replace(/\/+/g, "/");
	const trimmed = normalized.replace(/\/$/, "");
	return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed}`;
}

function joinPaths(...parts: string[]): string {
	const joined = parts
		.map((part) => part.trim())
		.filter((part) => part && part !== "/")
		.join("/");
	return toOpenApiPath(`/${joined}`);
}

/** The string a decorator or a call was given, when it was given one. */
function firstStringArgument(args: string): string | null {
	const trimmed = args.trim();
	const match = trimmed.match(/^(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/);
	if (match) return match[1] ?? match[2] ?? match[3] ?? "";
	// `@Controller({ path: 'users', version: '1' })`
	const pathProperty = trimmed.match(
		/\bpath\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/,
	);
	if (pathProperty) {
		return pathProperty[1] ?? pathProperty[2] ?? pathProperty[3] ?? "";
	}
	return null;
}

// ── NestJS ────────────────────────────────────────────────────────────────────

function detectNest(
	content: string,
	relativePath: string,
): DetectedRoute[] {
	const routes: DetectedRoute[] = [];
	const controllerRe = /@Controller\s*\(/g;
	let controller: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((controller = controllerRe.exec(content)) !== null) {
		const open = controller.index + controller[0].length - 1;
		const close = findMatching(content, open, "(", ")", SCAN);
		const prefix = firstStringArgument(content.slice(open + 1, close)) ?? "";

		const classMatch = /class\s+(\w+)/.exec(content.slice(close));
		if (!classMatch) continue;
		const className = classMatch[1];
		const bodyStart = content.indexOf("{", close + classMatch.index);
		if (bodyStart === -1) continue;
		const bodyEnd = findMatching(content, bodyStart, "{", "}", SCAN);
		const body = content.slice(bodyStart + 1, bodyEnd);
		controllerRe.lastIndex = bodyEnd;

		const header = content.slice(
			Math.max(0, controller.index - 400),
			controller.index,
		);
		const tag =
			firstStringArgument(
				/@ApiTags\s*\(([^)]*)\)/.exec(header)?.[1] ?? "",
			) ?? className.replace(/Controller$/, "");
		const classGuarded = /@UseGuards\s*\(/.test(header);

		const methodRe = new RegExp(
			`@(${HTTP_DECORATORS.join("|")})\\s*\\(`,
			"g",
		);
		let method: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((method = methodRe.exec(body)) !== null) {
			const argsOpen = method.index + method[0].length - 1;
			const argsClose = findMatching(body, argsOpen, "(", ")", SCAN);
			const suffix =
				firstStringArgument(body.slice(argsOpen + 1, argsClose)) ?? "";
			const context = body.slice(Math.max(0, method.index - 300), method.index);

			const verb = method[1] === "All" ? "GET" : method[1].toUpperCase();
			routes.push({
				path: joinPaths(prefix, suffix),
				methods: [verb],
				tag,
				file: relativePath,
				framework: "NestJS",
				requiresAuth: classGuarded || /@UseGuards\s*\(/.test(context),
			});
			methodRe.lastIndex = argsClose;
		}
	}

	return routes;
}

// ── Express and Fastify ───────────────────────────────────────────────────────

interface NodeFile {
	relativePath: string;
	content: string;
	/** Local identifier → absolute path of the module it was imported from. */
	imports: Map<string, string>;
	/** Identifiers assigned a `Router()`. */
	routerVars: Set<string>;
	/** `app.use('/api', x)` → the prefix that applies to `x`. */
	mounts: Array<{ prefix: string; target: string }>;
}

function resolveImport(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = path.resolve(path.dirname(fromFile), specifier);
	// The extension is dropped in TypeScript and often in JS; the file map is
	// keyed without one so both spellings meet.
	return base.replace(/\.(m|c)?[jt]sx?$/, "");
}

function readNodeFile(
	absolutePath: string,
	projectPath: string,
	content: string,
): NodeFile {
	const imports = new Map<string, string>();
	const importRe =
		/(?:import\s+(\w+)\s+from\s*|const\s+(\w+)\s*=\s*require\s*\(\s*)['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = importRe.exec(content)) !== null) {
		const local = match[1] ?? match[2];
		const resolved = resolveImport(absolutePath, match[3]);
		if (local && resolved) imports.set(local, resolved);
	}

	const routerVars = new Set<string>();
	const routerRe =
		/(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:express\s*\.\s*)?Router\s*\(/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = routerRe.exec(content)) !== null) routerVars.add(match[1]);

	const mounts: Array<{ prefix: string; target: string }> = [];
	const useRe = /(\w+)\s*\.\s*use\s*\(/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = useRe.exec(content)) !== null) {
		const open = match.index + match[0].length - 1;
		const close = findMatching(content, open, "(", ")", SCAN);
		useRe.lastIndex = close;
		const args = splitTopLevel(content.slice(open + 1, close), ",", SCAN);
		if (args.length < 2) continue;
		const prefix = firstStringArgument(args[0]);
		if (prefix === null) continue;
		for (const arg of args.slice(1)) {
			const target = arg.trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
			if (target) mounts.push({ prefix, target });
		}
	}

	return {
		relativePath: path.relative(projectPath, absolutePath),
		content,
		imports,
		routerVars,
		mounts,
	};
}

/**
 * The prefix each router carries, following one level of mounting across
 * files: `app.use('/api', usersRouter)` in the entry point gives every route
 * declared in `routes/users.ts` its `/api`.
 */
function prefixesByFile(
	files: Map<string, NodeFile>,
): Map<string, string> {
	const prefixes = new Map<string, string>();
	for (const [absolutePath, file] of files) {
		for (const mount of file.mounts) {
			const importedFrom = file.imports.get(mount.target);
			if (!importedFrom) continue;
			const targetKey = [...files.keys()].find(
				(key) => key.replace(/\.(m|c)?[jt]sx?$/, "") === importedFrom,
			);
			if (targetKey && targetKey !== absolutePath) {
				prefixes.set(targetKey, mount.prefix);
			}
		}
	}
	return prefixes;
}

function detectExpressRoutes(
	file: NodeFile,
	filePrefix: string,
): DetectedRoute[] {
	const routes: DetectedRoute[] = [];
	const localPrefixes = new Map<string, string>();
	for (const mount of file.mounts) {
		if (file.routerVars.has(mount.target)) {
			localPrefixes.set(mount.target, mount.prefix);
		}
	}

	const tag = path.basename(file.relativePath).replace(/\.[^.]+$/, "");
	const routeRe = new RegExp(
		`(\\w+)\\s*\\.\\s*(${HTTP_METHODS.join("|")})\\s*\\(`,
		"g",
	);
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = routeRe.exec(file.content)) !== null) {
		const receiver = match[1];
		const open = match.index + match[0].length - 1;
		const close = findMatching(file.content, open, "(", ")", SCAN);
		routeRe.lastIndex = close;

		const args = splitTopLevel(
			file.content.slice(open + 1, close),
			",",
			SCAN,
		);
		if (args.length < 2) continue; // `.get(url)` is a client call, not a route.
		const declared = firstStringArgument(args[0]);
		if (declared === null) continue;

		// A router mounted in this file carries its own prefix; one exported to
		// be mounted elsewhere carries the prefix from there.
		const prefix = file.routerVars.has(receiver)
			? (localPrefixes.get(receiver) ?? filePrefix)
			: "";

		routes.push({
			path: joinPaths(prefix, declared),
			methods: [match[2].toUpperCase()],
			tag,
			file: file.relativePath,
			framework: "Express",
			requiresAuth: false,
		});
	}

	return routes;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function detectNode(projectPath: string): DetectedRoute[] {
	const files = new Map<string, NodeFile>();
	for (const absolutePath of walkFiles(projectPath, NODE_EXTENSIONS)) {
		if (/\.(test|spec|d)\.[^.]+$/.test(absolutePath)) continue;
		const content = readFile(absolutePath);
		if (!content) continue;
		files.set(absolutePath, readNodeFile(absolutePath, projectPath, content));
	}

	const prefixes = prefixesByFile(files);
	const routes: DetectedRoute[] = [];

	for (const [absolutePath, file] of files) {
		if (file.content.includes("@Controller")) {
			routes.push(...detectNest(file.content, file.relativePath));
		}
		routes.push(
			...detectExpressRoutes(file, prefixes.get(absolutePath) ?? ""),
		);
	}

	return routes;
}
