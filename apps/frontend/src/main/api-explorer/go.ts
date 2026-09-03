import path from "node:path";
import { findMatching } from "./csharp-syntax";
import { readFile, walkFiles } from "./source-files";
import type { DetectedRoute } from "./types";

/**
 * Gin, Echo, Fiber and Chi.
 *
 * Groups are how every Go router expresses a base path — `api := r.Group("/api")`,
 * or Chi's `r.Route("/api", func(r chi.Router) { … })` — and the previous pass
 * ignored them, reporting `/users` for a route served at `/api/v1/users`.
 */

const VERBS = [
	"GET",
	"POST",
	"PUT",
	"DELETE",
	"PATCH",
	"HEAD",
	"OPTIONS",
	"Get",
	"Post",
	"Put",
	"Delete",
	"Patch",
	"Head",
	"Options",
];

/** Gin writes `:id` and `*rest`; Chi and Echo already write `{id}`. */
export function toOpenApiPath(routePath: string): string {
	const normalized = routePath
		.replace(/:([A-Za-z_][\w]*)/g, "{$1}")
		.replace(/\*([A-Za-z_][\w]*)/g, "{$1}")
		.replace(/\/+/g, "/");
	const trimmed =
		normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
	return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed}`;
}

function joinPaths(...parts: string[]): string {
	const joined = parts
		.map((part) => part.trim())
		.filter((part) => part && part !== "/")
		.join("/");
	return toOpenApiPath(`/${joined}`);
}

interface RouteBlock {
	start: number;
	end: number;
	prefix: string;
}

export function detectGo(projectPath: string): DetectedRoute[] {
	const routes: DetectedRoute[] = [];

	for (const file of walkFiles(projectPath, [".go"])) {
		const content = readFile(file);
		if (!content) continue;
		const relativePath = path.relative(projectPath, file);
		const tag = path.basename(file, ".go");

		// `api := r.Group("/api")`, resolved through however many levels.
		const groups = new Map<string, { parent: string; prefix: string }>();
		const groupRe = /(\w+)\s*:?=\s*(\w+)\s*\.\s*Group\s*\(\s*"([^"]*)"/g;
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((match = groupRe.exec(content)) !== null) {
			groups.set(match[1], { parent: match[2], prefix: match[3] });
		}

		const prefixOf = (receiver: string): string => {
			const parts: string[] = [];
			const seen = new Set<string>();
			let current = receiver;
			while (groups.has(current) && !seen.has(current)) {
				seen.add(current);
				const group = groups.get(current) as { parent: string; prefix: string };
				parts.unshift(group.prefix);
				current = group.parent;
			}
			return parts.join("/");
		};

		// Chi's `r.Route("/api", func(r chi.Router) { … })` scopes its prefix to
		// the closure rather than to a variable.
		const blocks: RouteBlock[] = [];
		const routeBlockRe =
			/(\w+)\s*\.\s*Route\s*\(\s*"([^"]*)"\s*,\s*func\s*\([^)]*\)\s*\{/g;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((match = routeBlockRe.exec(content)) !== null) {
			const braceIndex = content.indexOf("{", match.index + match[0].length - 1);
			const end = findMatching(content, braceIndex, "{", "}");
			blocks.push({
				start: braceIndex,
				end,
				prefix: joinPaths(prefixOf(match[1]), match[2]),
			});
		}
		const blockPrefixAt = (index: number): string | null => {
			const enclosing = blocks
				.filter((block) => index > block.start && index < block.end)
				.sort((a, b) => b.start - a.start)[0];
			return enclosing ? enclosing.prefix : null;
		};

		const routeRe = new RegExp(
			`(\\w+)\\s*\\.\\s*(${VERBS.join("|")})\\s*\\(\\s*"([^"]*)"`,
			"g",
		);
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((match = routeRe.exec(content)) !== null) {
			const fromBlock = blockPrefixAt(match.index);
			const prefix = fromBlock ?? prefixOf(match[1]);
			routes.push({
				path: joinPaths(prefix, match[3]),
				methods: [match[2].toUpperCase()],
				tag,
				file: relativePath,
				framework: "Go",
				requiresAuth: false,
			});
		}
	}

	return routes;
}
