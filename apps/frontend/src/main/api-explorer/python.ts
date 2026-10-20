import path from "node:path";
import { findMatching, splitTopLevel } from "./csharp-syntax";
import { readFile, walkFiles } from "./source-files";
import type { DetectedRoute } from "./types";

/**
 * FastAPI, Flask and Django.
 *
 * As with Node, the paths a decorator carries are rarely the paths served:
 * `@router.get("/")` on an `APIRouter(prefix="/items")` included under
 * `/api/v1` answers on `/api/v1/items`, and a Flask blueprint carries its
 * `url_prefix` the same way. Reporting the decorator alone sends the explorer
 * to a URL that does not exist.
 */

const PYTHON_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];

/** `<int:id>` in Flask and `<pk>` in Django are what OpenAPI writes `{id}`. */
export function toOpenApiPath(routePath: string): string {
	const normalized = routePath
		.replace(/<(?:[^:<>]+:)?([^<>]+)>/g, "{$1}")
		.replace(/\/+/g, "/");
	const trimmed = normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
	return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed}`;
}

function joinPaths(...parts: string[]): string {
	const joined = parts
		.map((part) => part.trim())
		.filter((part) => part && part !== "/")
		.join("/");
	return toOpenApiPath(`/${joined}`);
}

/** The value of a keyword argument, when it was given as a literal. */
function keywordString(args: string, keyword: string): string | null {
	const match = new RegExp(
		`\\b${keyword}\\s*=\\s*(?:'([^']*)'|"([^"]*)")`,
	).exec(args);
	return match ? (match[1] ?? match[2] ?? "") : null;
}

function firstPositionalString(args: string): string | null {
	const first = splitTopLevel(args)[0];
	if (!first) return null;
	const match = first.trim().match(/^(?:'([^']*)'|"([^"]*)")$/);
	return match ? (match[1] ?? match[2] ?? "") : null;
}

function callArgs(
	content: string,
	openParenIndex: number,
): { args: string; end: number } {
	const end = findMatching(content, openParenIndex, "(", ")");
	return { args: content.slice(openParenIndex + 1, end), end };
}

interface PythonFile {
	absolutePath: string;
	relativePath: string;
	content: string;
	/** Router or blueprint variable → the prefix declared on it. */
	ownPrefixes: Map<string, string>;
	/** Variable → prefix it was included/registered under, in this file. */
	includedPrefixes: Map<string, string>;
	/** Module imported as `x` → its resolved path, extension dropped. */
	imports: Map<string, string>;
	/** `include_router(users.router, prefix=…)` → prefix keyed by module name. */
	moduleIncludes: Array<{ module: string; prefix: string }>;
}

function readPythonFile(
	absolutePath: string,
	projectPath: string,
	content: string,
): PythonFile {
	const ownPrefixes = new Map<string, string>();
	const includedPrefixes = new Map<string, string>();
	const imports = new Map<string, string>();
	const moduleIncludes: Array<{ module: string; prefix: string }> = [];

	// `router = APIRouter(prefix="/items")` / `bp = Blueprint(..., url_prefix="/x")`
	const factoryRe = /(\w+)\s*=\s*(APIRouter|Blueprint)\s*\(/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = factoryRe.exec(content)) !== null) {
		const { args, end } = callArgs(content, match.index + match[0].length - 1);
		factoryRe.lastIndex = end;
		const prefix =
			keywordString(args, "prefix") ?? keywordString(args, "url_prefix") ?? "";
		ownPrefixes.set(match[1], prefix);
	}

	// `app.include_router(router, prefix="/api")` / `app.register_blueprint(bp, url_prefix="/api")`
	const includeRe = /\b(?:include_router|register_blueprint)\s*\(/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = includeRe.exec(content)) !== null) {
		const { args, end } = callArgs(content, match.index + match[0].length - 1);
		includeRe.lastIndex = end;
		const parts = splitTopLevel(args);
		const target = parts[0]?.trim();
		if (!target) continue;
		const prefix =
			keywordString(args, "prefix") ?? keywordString(args, "url_prefix") ?? "";
		if (/^\w+$/.test(target)) {
			includedPrefixes.set(target, prefix);
		} else {
			// `users.router` — the prefix belongs to the module it came from.
			const module = target.split(".")[0];
			if (/^\w+$/.test(module)) moduleIncludes.push({ module, prefix });
		}
	}

	const importRe =
		/^\s*(?:from\s+([\w.]+)\s+import\s+([\w, ]+)|import\s+([\w.]+))/gm;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = importRe.exec(content)) !== null) {
		const moduleName = match[1] ?? match[3];
		if (!moduleName) continue;
		const relative = moduleName.replace(/^\.+/, "").split(".").join(path.sep);
		const moduleDir = path.resolve(path.dirname(absolutePath), relative);
		const local = (match[3] ?? moduleName).split(".").pop();
		if (local) imports.set(local, moduleDir);
		// `from routers import items` names a submodule: the file is
		// `routers/items.py`, not `routers` itself.
		for (const imported of (match[2] ?? "").split(",")) {
			const name = imported.trim().split(/\s+as\s+/).pop()?.trim();
			if (name) imports.set(name, path.join(moduleDir, name));
		}
	}

	return {
		absolutePath,
		relativePath: path.relative(projectPath, absolutePath),
		content,
		ownPrefixes,
		includedPrefixes,
		imports,
		moduleIncludes,
	};
}

/** Prefix contributed to a file by an `include_router` in another file. */
function prefixesByFile(files: PythonFile[]): Map<string, string> {
	const prefixes = new Map<string, string>();
	const byStem = new Map<string, string>();
	for (const file of files) {
		byStem.set(file.absolutePath.replace(/\.py$/, ""), file.absolutePath);
	}

	for (const file of files) {
		for (const include of file.moduleIncludes) {
			const resolved = file.imports.get(include.module);
			if (!resolved) continue;
			const target =
				byStem.get(resolved) ?? byStem.get(path.join(resolved, "__init__"));
			if (target && target !== file.absolutePath) {
				prefixes.set(target, include.prefix);
			}
		}
	}
	return prefixes;
}

function detectRoutes(file: PythonFile, filePrefix: string): DetectedRoute[] {
	const routes: DetectedRoute[] = [];
	const tag = path.basename(file.relativePath, ".py");
	// `@app.get` exists in both Flask 2 and FastAPI; the import says which.
	const verbFramework = /\bfrom\s+fastapi\b|FastAPI\s*\(|APIRouter\s*\(/.test(
		file.content,
	)
		? "FastAPI"
		: /\bfrom\s+flask\b|Flask\s*\(|Blueprint\s*\(/.test(file.content)
			? "Flask"
			: "FastAPI";

	const prefixFor = (receiver: string): string => {
		const own = file.ownPrefixes.get(receiver);
		if (own === undefined) return "";
		const included = file.includedPrefixes.get(receiver);
		return joinPaths(included ?? filePrefix, own);
	};

	// FastAPI and Flask verb decorators: @router.get("/x"), @bp.post("/y")
	const verbRe = new RegExp(
		`@(\\w+)\\s*\\.\\s*(${PYTHON_METHODS.join("|")})\\s*\\(`,
		"g",
	);
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = verbRe.exec(file.content)) !== null) {
		const { args, end } = callArgs(
			file.content,
			match.index + match[0].length - 1,
		);
		verbRe.lastIndex = end;
		const declared = firstPositionalString(args);
		if (declared === null) continue;
		routes.push({
			path: joinPaths(prefixFor(match[1]), declared),
			methods: [match[2].toUpperCase()],
			tag,
			file: file.relativePath,
			framework: verbFramework,
			requiresAuth: /Depends\s*\(/.test(args),
		});
	}

	// Flask's @app.route("/x", methods=[...])
	const routeRe = /@(\w+)\s*\.\s*route\s*\(/g;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = routeRe.exec(file.content)) !== null) {
		const { args, end } = callArgs(
			file.content,
			match.index + match[0].length - 1,
		);
		routeRe.lastIndex = end;
		const declared = firstPositionalString(args);
		if (declared === null) continue;
		const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(args)?.[1];
		routes.push({
			path: joinPaths(prefixFor(match[1]), declared),
			methods: methods
				? methods
						.split(",")
						.map((verb) => verb.trim().replace(/['"]/g, "").toUpperCase())
						.filter(Boolean)
				: ["GET"],
			tag,
			file: file.relativePath,
			framework: "Flask",
			requiresAuth: /login_required/.test(args),
		});
	}

	// Django's path("users/<int:pk>/", …) inside urlpatterns
	if (file.content.includes("urlpatterns")) {
		const djangoRe = /\b(?:path|re_path)\s*\(\s*(?:r?'([^']*)'|r?"([^"]*)")/g;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((match = djangoRe.exec(file.content)) !== null) {
			const declared = match[1] ?? match[2] ?? "";
			routes.push({
				path: joinPaths(filePrefix, declared),
				methods: ["GET"],
				tag,
				file: file.relativePath,
				framework: "Django",
				requiresAuth: false,
			});
		}
	}

	return routes;
}

export function detectPython(projectPath: string): DetectedRoute[] {
	const files: PythonFile[] = [];
	for (const absolutePath of walkFiles(projectPath, [".py"])) {
		const content = readFile(absolutePath);
		if (!content) continue;
		files.push(readPythonFile(absolutePath, projectPath, content));
	}

	const prefixes = prefixesByFile(files);
	return files.flatMap((file) =>
		detectRoutes(file, prefixes.get(file.absolutePath) ?? ""),
	);
}
