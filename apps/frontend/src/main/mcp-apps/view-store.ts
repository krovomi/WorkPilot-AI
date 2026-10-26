/**
 * The MCP App views a build kept for its task (`<spec>/mcp-apps/<viewId>.json`).
 *
 * Written by the backend (`core/mcp_extensions.py`, `capture_app_view`), read
 * here only. Every file is the server's content: it is parsed with a schema,
 * size-capped, and read only from inside the task's own spec directories, by
 * an id that matches `VIEW_ID` (no path from the renderer ever reaches here).
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpAppViewSummary } from "../../shared/types/mcp-apps";

export const APP_VIEWS_DIR = "mcp-apps";
export const VIEW_ID = /^[0-9a-f]{16}$/;
/** The backend keeps 1 000 000 characters of HTML and 256 000 of result. */
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_VIEWS = 50;

const Domains = z.array(z.string().max(300)).max(64).optional();

export const ViewUiSchema = z
	.object({
		csp: z
			.object({
				connectDomains: Domains,
				resourceDomains: Domains,
				frameDomains: Domains,
				baseUriDomains: Domains,
			})
			.passthrough()
			.optional(),
		prefersBorder: z.boolean().optional(),
	})
	.passthrough();

export type ViewUi = z.infer<typeof ViewUiSchema>;

const ViewFileSchema = z.object({
	viewId: z.string().regex(VIEW_ID),
	server: z.string().min(1).max(200),
	tool: z.string().min(1).max(200),
	resourceUri: z.string().startsWith("ui://").max(2000),
	html: z.string().min(1).max(1_000_000),
	ui: ViewUiSchema.catch({}),
	toolInput: z.record(z.string(), z.unknown()).catch({}),
	toolResult: z.record(z.string(), z.unknown()).catch({}),
	createdAt: z.number().finite().nonnegative(),
});

export type McpAppViewFile = z.infer<typeof ViewFileSchema>;

/** The views folder of a spec directory, when it is a real folder inside it. */
function viewsFolder(specDir: string): string | null {
	try {
		const root = realpathSync(specDir);
		const folder = path.join(root, APP_VIEWS_DIR);
		if (!lstatSync(folder).isDirectory()) return null;
		return realpathSync(folder) === folder ? folder : null;
	} catch {
		return null;
	}
}

function readViewFile(folder: string, viewId: string): McpAppViewFile | null {
	if (!VIEW_ID.test(viewId)) return null;
	const file = path.join(folder, `${viewId}.json`);
	try {
		const stat = lstatSync(file);
		// A link could point anywhere on the disk: only plain files are read.
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
		const parsed = ViewFileSchema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
		if (!parsed.success || parsed.data.viewId !== viewId) return null;
		return parsed.data;
	} catch {
		return null;
	}
}

function summary(view: McpAppViewFile): McpAppViewSummary {
	return {
		viewId: view.viewId,
		server: view.server,
		tool: view.tool,
		createdAt: view.createdAt,
	};
}

/** The views of a task, newest first, each once (main and worktree copies). */
export function listMcpAppViews(specDirs: readonly string[]): McpAppViewSummary[] {
	const seen = new Map<string, McpAppViewSummary>();
	for (const dir of specDirs) {
		const folder = viewsFolder(dir);
		if (!folder) continue;
		let names: string[];
		try {
			names = readdirSync(folder);
		} catch {
			continue;
		}
		for (const name of names) {
			const viewId = name.endsWith(".json") ? name.slice(0, -5) : "";
			if (seen.has(viewId) || !VIEW_ID.test(viewId)) continue;
			const view = readViewFile(folder, viewId);
			if (view) seen.set(viewId, summary(view));
		}
	}
	return [...seen.values()]
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, MAX_VIEWS);
}

/** One view of a task, by its id, or null. */
export function readMcpAppView(
	specDirs: readonly string[],
	viewId: unknown,
): McpAppViewFile | null {
	if (typeof viewId !== "string" || !VIEW_ID.test(viewId)) return null;
	for (const dir of specDirs) {
		const folder = viewsFolder(dir);
		const view = folder ? readViewFile(folder, viewId) : null;
		if (view) return view;
	}
	return null;
}
