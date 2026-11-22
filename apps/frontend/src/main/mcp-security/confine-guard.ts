/**
 * Confinement of a low-score MCP server, written where the project's
 * settings are (`env:update`, issue #369 lot 5).
 *
 * When the project's MCP policy has `confineBelow`, each command server of
 * the list the renderer sends that has no `confine` of its own gets
 * `confine: { hosts: [] }` if it is outside the catalog (no score) or its
 * score, the main's (`InstallGuardDeps.score`), is under the threshold. The
 * backend then starts it only in the OS sandbox, with the hosts listed and
 * its launcher's registry (`apps/backend/core/mcp_confinement.py`). Every
 * server of the list is looked at, kept ones included: confining only
 * narrows what a server may do. A `confine` already there is kept as it is,
 * hosts included; the backend refuses one that is malformed.
 */

import { matchCatalogServer } from "../../shared/mcp-catalog/catalog-match";
import { policyConfines } from "../../shared/mcp-catalog/install-policy";
import type { InstallGuardDeps } from "./install-guard";

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * `servers` as they are written: confined where the policy asks. `servers`
 * undefined (not part of this update) or not a list comes back unchanged.
 */
export async function withMcpConfinement<T>(
	projectPath: string,
	servers: T,
	deps: InstallGuardDeps,
): Promise<T> {
	if (!Array.isArray(servers) || servers.length === 0) return servers;
	const state = deps.readPolicy(projectPath);
	if (state.state !== "active" || state.policy.confineBelow === undefined) return servers;
	const catalog = deps.catalog();
	const out: unknown[] = [];
	for (const server of servers) {
		const value = record(server);
		if (value?.type !== "command" || "confine" in value) {
			out.push(server);
			continue;
		}
		const entry = matchCatalogServer(server, catalog);
		const score = entry ? await deps.score(entry, projectPath) : undefined;
		out.push(
			policyConfines(state, { entry, ...(score !== undefined ? { score } : {}) })
				? { ...value, confine: { hosts: [] } }
				: server,
		);
	}
	return out as T;
}
