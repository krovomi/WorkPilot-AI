/**
 * MCP Marketplace → project custom MCP server.
 *
 * Installing a catalog server writes a `CustomMcpServer` into the project's
 * `.workpilot/.env` (`CUSTOM_MCP_SERVERS`) and adds it to the agents the user
 * picked (`AGENT_MCP_<agent>_ADD`): that is what `core.client` starts. The
 * marketplace keeps no list of its own, so what it shows as installed is what
 * the agents get.
 */

import type {
	LocalizedText,
	McpMarketplaceServer,
} from "../types/mcp-marketplace";
import type { AgentMcpOverrides, CustomMcpServer } from "../types/project";
import catalogFile from "./servers.json";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The catalog shipped with the app. */
export function loadMcpCatalog(): McpMarketplaceServer[] {
	return (catalogFile as { servers: McpMarketplaceServer[] }).servers;
}

/** `text` in the UI language (French when it starts with "fr", else English). */
export function localized(text: LocalizedText, language: string): string {
	return language.toLowerCase().startsWith("fr") ? text.fr : text.en;
}

/** The variable names `value` refers to with `${NAME}`. */
function placeholders(value: string): string[] {
	return [...value.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** Every variable a placeholder of `entry` names. */
export function placeholderVars(entry: McpMarketplaceServer): Set<string> {
	const names = new Set<string>();
	const texts = [
		...(entry.args ?? []),
		entry.url ?? "",
		...Object.values(entry.headers ?? {}),
	];
	for (const text of texts) {
		for (const name of placeholders(text)) names.add(name);
	}
	return names;
}

/** Required variables still empty in `values`. */
export function missingCatalogVars(
	entry: McpMarketplaceServer,
	values: Record<string, string>,
): string[] {
	return entry.vars
		.filter((v) => v.required && !values[v.name]?.trim())
		.map((v) => v.name);
}

/**
 * `text` with its placeholders filled, or `null` when one names an empty
 * value (the arg or header is then left out: only optional variables can be
 * empty here, `missingCatalogVars` stops the rest).
 */
function fill(text: string, values: Record<string, string>): string | null {
	let empty = false;
	const out = text.replace(PLACEHOLDER, (_m, name: string) => {
		const value = values[name]?.trim() ?? "";
		if (!value) empty = true;
		return value;
	});
	return empty ? null : out;
}

export type CatalogServerBuild =
	| { ok: true; server: CustomMcpServer }
	| { ok: false; missing: string[] };

/** The project custom server `entry` becomes with the values the user typed. */
export function buildCatalogServer(
	entry: McpMarketplaceServer,
	values: Record<string, string>,
	language = "en",
): CatalogServerBuild {
	const missing = missingCatalogVars(entry, values);
	if (missing.length > 0) return { ok: false, missing };

	const base = {
		id: entry.id,
		name: entry.name,
		description: localized(entry.tagline, language),
	};

	if (entry.transport === "stdio") {
		const args = (entry.args ?? [])
			.map((arg) => fill(arg, values))
			.filter((arg): arg is string => arg !== null);
		const referenced = placeholderVars(entry);
		const env: Record<string, string> = { ...(entry.env ?? {}) };
		for (const v of entry.vars) {
			const value = values[v.name]?.trim();
			if (value && !referenced.has(v.name)) env[v.name] = value;
		}
		return {
			ok: true,
			server: {
				...base,
				type: "command",
				command: entry.command ?? "npx",
				args,
				...(Object.keys(env).length > 0 ? { env } : {}),
			},
		};
	}

	const url = fill(entry.url ?? "", values);
	if (!url) return { ok: false, missing: placeholders(entry.url ?? "") };
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(entry.headers ?? {})) {
		const filled = fill(value, values);
		if (filled !== null) headers[key] = filled;
	}
	return {
		ok: true,
		server: {
			...base,
			type: "http",
			url,
			...(Object.keys(headers).length > 0 ? { headers } : {}),
		},
	};
}

/** The agents a server installed from the marketplace is given by default. */
export const DEFAULT_MCP_AGENTS = ["planner", "coder", "qa_reviewer"] as const;

/** `overrides` with `serverId` added to each of `agents`. */
export function withServerForAgents(
	overrides: AgentMcpOverrides | undefined,
	serverId: string,
	agents: readonly string[],
): AgentMcpOverrides {
	const next: AgentMcpOverrides = { ...(overrides ?? {}) };
	for (const agent of agents) {
		const current = next[agent] ?? {};
		const add = current.add ?? [];
		next[agent] = {
			...current,
			add: add.includes(serverId) ? add : [...add, serverId],
			remove: (current.remove ?? []).filter((id) => id !== serverId),
		};
	}
	return next;
}

/** `overrides` without any mention of `serverId`. */
export function withoutServer(
	overrides: AgentMcpOverrides | undefined,
	serverId: string,
): AgentMcpOverrides {
	const next: AgentMcpOverrides = {};
	for (const [agent, override] of Object.entries(overrides ?? {})) {
		next[agent] = {
			...override,
			add: (override.add ?? []).filter((id) => id !== serverId),
			remove: (override.remove ?? []).filter((id) => id !== serverId),
		};
	}
	return next;
}

/** The agents whose overrides add `serverId`. */
export function agentsUsingServer(
	overrides: AgentMcpOverrides | undefined,
	serverId: string,
): string[] {
	return Object.entries(overrides ?? {})
		.filter(([, o]) => o.add?.includes(serverId))
		.map(([agent]) => agent);
}
