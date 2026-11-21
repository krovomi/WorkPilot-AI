/**
 * Is a project's custom MCP server the catalog server it names (#369, lot 2)?
 *
 * Installing from the marketplace writes the catalog's launcher, arguments,
 * URL and headers, with the values the person typed in their placeholders
 * (`buildCatalogServer`). A server whose id is a catalog id but whose command,
 * arguments, URL, headers or environment are anything else is not that
 * server: the policy and the daily check treat it as a server outside the
 * catalog, never read on the network.
 */

import type { McpMarketplaceServer } from "../types/mcp-marketplace";
import type { CustomMcpServer } from "../types/project";
import { placeholderVars } from "./install";

const PLACEHOLDERS = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;
const PLACEHOLDER_NAMES = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function strings(value: unknown): string[] | null {
	if (value === undefined) return [];
	return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
}

function stringMap(value: unknown): Record<string, string> | null {
	if (value === undefined) return {};
	const map = record(value);
	if (!map || !Object.values(map).every((v) => typeof v === "string")) return null;
	return map as Record<string, string>;
}

/**
 * `value` is `template` with each placeholder filled by some non-empty text.
 * Literal pieces are found left to right (no regular expression: a long value
 * from the renderer cannot make the main process backtrack).
 */
function matchesTemplate(template: string, value: string): boolean {
	const parts = template.split(PLACEHOLDERS);
	if (parts.length === 1) return value === template;
	const first = parts[0];
	const last = parts[parts.length - 1];
	if (!value.startsWith(first)) return false;
	let pos = first.length;
	for (const middle of parts.slice(1, -1)) {
		const at = value.indexOf(middle, pos + 1);
		if (at < 0) return false;
		pos = at + middle.length;
	}
	return value.length - last.length > pos && value.endsWith(last);
}

/**
 * The template may be left out: one of its placeholders names a value the
 * person may leave empty (`buildCatalogServer` then drops it).
 */
function optionalIn(entry: McpMarketplaceServer): (template: string) => boolean {
	const required = new Set(entry.vars.filter((v) => v.required).map((v) => v.name));
	return (template) =>
		[...template.matchAll(PLACEHOLDER_NAMES)].some((m) => !required.has(m[1]));
}

/**
 * `args` are `templates` filled, in the catalog's order: a template is there,
 * filled, unless it may be left out.
 */
function argsMatch(
	templates: readonly string[],
	args: readonly string[],
	optional: (template: string) => boolean,
): boolean {
	if (templates.length === 0) return args.length === 0;
	const [template, ...rest] = templates;
	if (
		args.length > 0 &&
		matchesTemplate(template, args[0]) &&
		argsMatch(rest, args.slice(1), optional)
	) {
		return true;
	}
	return optional(template) && argsMatch(rest, args, optional);
}

function envMatches(entry: McpMarketplaceServer, env: Record<string, string>): boolean {
	const referenced = placeholderVars(entry);
	const typed = new Set(entry.vars.map((v) => v.name).filter((name) => !referenced.has(name)));
	const fixed = entry.env ?? {};
	for (const [key, value] of Object.entries(fixed)) {
		if (!typed.has(key) && env[key] !== value) return false;
	}
	return Object.entries(env).every(
		([key, value]) => typed.has(key) || (Object.hasOwn(fixed, key) && fixed[key] === value),
	);
}

function headersMatch(
	templates: Record<string, string>,
	headers: Record<string, string>,
	optional: (template: string) => boolean,
): boolean {
	for (const [key, template] of Object.entries(templates)) {
		if (!Object.hasOwn(headers, key) && !optional(template)) return false;
	}
	return Object.entries(headers).every(
		([key, value]) => Object.hasOwn(templates, key) && matchesTemplate(templates[key], value),
	);
}

/**
 * The catalog entry `server` is, or null when it is not one: another id, or
 * the id of a catalog server with something of its own.
 */
export function matchCatalogServer(
	server: CustomMcpServer | unknown,
	catalog: readonly McpMarketplaceServer[],
): McpMarketplaceServer | null {
	const value = record(server);
	if (!value || typeof value.id !== "string") return null;
	const entry = catalog.find((s) => s.id === value.id);
	if (!entry) return null;

	if (entry.transport === "stdio") {
		const args = strings(value.args);
		const env = stringMap(value.env);
		const ok =
			value.type === "command" &&
			value.command === (entry.command ?? "npx") &&
			args !== null &&
			env !== null &&
			argsMatch(entry.args ?? [], args, optionalIn(entry)) &&
			envMatches(entry, env);
		return ok ? entry : null;
	}
	const headers = stringMap(value.headers);
	const ok =
		value.type === "http" &&
		typeof value.url === "string" &&
		matchesTemplate(entry.url ?? "", value.url) &&
		headers !== null &&
		headersMatch(entry.headers ?? {}, headers, optionalIn(entry));
	return ok ? entry : null;
}
