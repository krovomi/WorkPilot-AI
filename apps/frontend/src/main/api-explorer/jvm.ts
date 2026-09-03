import path from "node:path";
import { findMatching, splitTopLevel } from "./csharp-syntax";
import { readFile, walkFiles } from "./source-files";
import type { DetectedRoute } from "./types";

/**
 * Spring Boot, in Java and Kotlin.
 *
 * The previous pass matched a single `@RequestMapping("…")` per file and only
 * in its bare string form, so a controller declaring `@RequestMapping(path =
 * "/api/users")` lost its base path entirely, and a second controller in the
 * same file was read against the first one's. Both produce paths that do not
 * exist.
 */

const MAPPINGS: Record<string, string> = {
	GetMapping: "GET",
	PostMapping: "POST",
	PutMapping: "PUT",
	DeleteMapping: "DELETE",
	PatchMapping: "PATCH",
};

function joinPaths(...parts: string[]): string {
	const joined = parts
		.map((part) => part.trim())
		.filter((part) => part && part !== "/")
		.join("/");
	const normalized = `/${joined}`.replace(/\/+/g, "/");
	return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

/**
 * The path an annotation declares, in any of the forms Spring accepts:
 * `("/a")`, `(path = "/a")`, `(value = "/a")`, `({"/a", "/b"})`. The first of
 * several is used — an explorer needs one address per operation, and the
 * first is the one Spring documents.
 */
export function annotationPath(args: string): string | null {
	const text = args.trim();
	if (!text) return "";

	const named = /\b(?:path|value)\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(text);
	const source = named ? named[1] : splitTopLevel(text)[0] ?? "";

	const literals = [...source.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
	if (literals.length > 0) return literals[0];
	// `(produces = MediaType.APPLICATION_JSON_VALUE)` declares no path.
	return /\b(?:path|value)\s*=/.test(text) || source.includes('"') ? null : "";
}

/** The verb of a bare `@RequestMapping(method = RequestMethod.POST)`. */
function requestMappingVerb(args: string): string {
	return /RequestMethod\.(\w+)/.exec(args)?.[1]?.toUpperCase() ?? "GET";
}

export function detectSpring(projectPath: string): DetectedRoute[] {
	const routes: DetectedRoute[] = [];

	for (const file of walkFiles(projectPath, [".java", ".kt"])) {
		const content = readFile(file);
		if (!content || !/@(?:Rest)?Controller\b/.test(content)) continue;
		const relativePath = path.relative(projectPath, file);

		const classRe = /\bclass\s+(\w+)/g;
		let classMatch: RegExpExecArray | null;
		// Where the previous declaration ended: a class's annotations start
		// there, never earlier, or a second controller in the same file reads
		// the first one's base path.
		let previousEnd = 0;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((classMatch = classRe.exec(content)) !== null) {
			const bodyStart = content.indexOf("{", classMatch.index);
			if (bodyStart === -1) continue;
			const bodyEnd = findMatching(content, bodyStart, "{", "}");
			const body = content.slice(bodyStart + 1, bodyEnd);
			classRe.lastIndex = bodyEnd;

			// Annotations sit above the declaration, after the previous one.
			const header = content.slice(previousEnd, classMatch.index);
			previousEnd = bodyEnd;
			if (!/@(?:Rest)?Controller\b/.test(header)) continue;

			const className = classMatch[1];
			// The nearest mapping is this class's; an earlier one belonged to
			// whatever came before it.
			const classMappings = [...header.matchAll(/@RequestMapping\s*\(/g)];
			const classMapping = classMappings.at(-1);
			let base = "";
			if (classMapping?.index !== undefined) {
				const open = classMapping.index + classMapping[0].length - 1;
				const close = findMatching(header, open, "(", ")");
				base = annotationPath(header.slice(open + 1, close)) ?? "";
			}
			const classSecured = /@(?:PreAuthorize|Secured|RolesAllowed)\b/.test(
				header,
			);
			const tag = className.replace(/Controller$/, "");

			const methodRe = new RegExp(
				`@(${Object.keys(MAPPINGS).join("|")}|RequestMapping)\\s*\\(?`,
				"g",
			);
			let method: RegExpExecArray | null;
			// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
			while ((method = methodRe.exec(body)) !== null) {
				let args = "";
				if (method[0].endsWith("(")) {
					const open = method.index + method[0].length - 1;
					const close = findMatching(body, open, "(", ")");
					args = body.slice(open + 1, close);
					methodRe.lastIndex = close;
				}

				const declared = annotationPath(args);
				if (declared === null) continue;

				const context = body.slice(
					Math.max(0, method.index - 300),
					method.index,
				);
				routes.push({
					path: joinPaths(base, declared),
					methods: [
						MAPPINGS[method[1]] ?? requestMappingVerb(args),
					],
					tag,
					file: relativePath,
					framework: "Spring Boot",
					requiresAuth:
						classSecured ||
						/@(?:PreAuthorize|Secured|RolesAllowed)\b/.test(context),
				});
			}
		}
	}

	return routes;
}
