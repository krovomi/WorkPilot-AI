/**
 * The MCP install policy, applied where the project's settings are written
 * (`env:update`, issue #369 lot 2).
 *
 * The renderer installs a server by sending the whole list of the project's
 * custom MCP servers: what the main process checks is each server of that
 * list that is new, or not the same as the one the file holds (a server
 * kept as it was passes, even under a policy written after it; removing one
 * always passes). A server is the catalog server it names only when it is
 * that server as the catalog defines it (`matchCatalogServer`); its score is
 * the one the main computes, from the cache of a day, never read in strict
 * offline mode. The first refusal is returned, with its reason.
 */

import { matchCatalogServer } from "../../shared/mcp-catalog/catalog-match";
import { policyNeedsScore, policyRefusal } from "../../shared/mcp-catalog/install-policy";
import type { McpMarketplaceServer } from "../../shared/types/mcp-marketplace";
import type { McpPolicyRefusal, McpPolicyState } from "../../shared/types/mcp-policy";

export interface InstallGuardDeps {
	readPolicy: (projectPath: string) => McpPolicyState;
	catalog: () => McpMarketplaceServer[];
	score: (entry: McpMarketplaceServer, projectPath: string) => Promise<number>;
}

const MAX_NAME = 100;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** JSON with its keys sorted: two servers equal whatever the key order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = record(value);
	if (object) {
		const keys = Object.keys(object).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function text(value: unknown): string {
	return typeof value === "string" ? value.slice(0, MAX_NAME) : "";
}

/**
 * The refusal the project's policy makes of the servers `after` adds or
 * changes over `before`, or null. `after` undefined: the servers are not
 * part of this update.
 */
export async function mcpInstallRefusal(
	projectPath: string,
	before: readonly unknown[],
	after: unknown,
	deps: InstallGuardDeps,
): Promise<McpPolicyRefusal | null> {
	if (after === undefined) return null;
	const kept = new Set(before.map(canonical));
	const changed = (Array.isArray(after) ? after : [after]).filter(
		(server) => !kept.has(canonical(server)),
	);
	if (changed.length === 0) return null;

	const state = deps.readPolicy(projectPath);
	if (state.state === "none") return null;
	const catalog = deps.catalog();
	for (const server of changed) {
		const value = record(server);
		const serverId = text(value?.id);
		const entry = matchCatalogServer(server, catalog);
		const score =
			entry && policyNeedsScore(state) ? await deps.score(entry, projectPath) : undefined;
		const refusal = policyRefusal(state, {
			serverId,
			name: text(value?.name) || serverId,
			entry,
			...(score !== undefined ? { score } : {}),
		});
		if (refusal) return refusal;
	}
	return null;
}

/** The English sentence of a refusal, for a caller that shows `error` as is. */
export function refusalMessage(refusal: McpPolicyRefusal): string {
	const name = refusal.name || refusal.serverId;
	switch (refusal.reason) {
		case "policyInvalid":
			return "The project's MCP policy (.workpilot/mcp-policy.json) is invalid: no server can be installed";
		case "notAllowed":
			return `The project's MCP policy does not allow ${name}`;
		case "scoreTooLow":
			return `The project's MCP policy needs a security score of ${refusal.minScore} or more; ${name} has ${refusal.score}`;
		default:
			return `The project's MCP policy refuses servers outside the catalog (${name})`;
	}
}
