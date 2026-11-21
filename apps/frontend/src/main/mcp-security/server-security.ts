/**
 * The security score the MCP Marketplace shows for a catalog server (#369).
 *
 * The renderer sends a server id, and optionally the id of the project it
 * installs into: both are checked here (S6). A project in strict offline mode
 * (`.workpilot/offline-mode.json`) gets the score from the catalog and the
 * last facts read, with no network call (S7).
 */

import { loadMcpCatalog } from "../../shared/mcp-catalog/install";
import { scoreServer } from "../../shared/mcp-catalog/security-score";
import type { McpMarketplaceServer } from "../../shared/types/mcp-marketplace";
import type {
	McpSecurityRequest,
	McpSecurityScore,
} from "../../shared/types/mcp-security";
import { packageOf, type RegistryFactsStore } from "./registry-facts";

export interface ServerSecurityDeps {
	store: RegistryFactsStore;
	/** The project's folder, for a registered project id; else undefined. */
	projectPath: (projectId: string) => string | undefined;
	offline: (projectPath: string) => boolean;
	catalog?: () => McpMarketplaceServer[];
}

export class McpSecurityRequestError extends Error {}

function parseRequest(raw: unknown): McpSecurityRequest {
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const { serverId, projectId, refresh } = value;
	if (typeof serverId !== "string" || !serverId) {
		throw new McpSecurityRequestError("A catalog server id is required");
	}
	if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
		throw new McpSecurityRequestError("Invalid project id");
	}
	return { serverId, projectId: projectId ?? null, refresh: refresh === true };
}

export type ScoreDeps = Pick<ServerSecurityDeps, "store" | "offline">;

/**
 * The score of catalog entry `entry` for a project at `projectPath` (none: no
 * offline mode to honour): its registry facts read or taken from the cache
 * of a day, never read for a project in strict offline mode.
 */
export async function scoreCatalogEntry(
	entry: McpMarketplaceServer,
	projectPath: string | undefined,
	deps: ScoreDeps,
	refresh = false,
): Promise<McpSecurityScore> {
	const ref = packageOf(entry);
	if (!ref) return scoreServer(entry);
	if (projectPath && deps.offline(projectPath)) {
		return scoreServer(entry, {
			facts: deps.store.cached(entry.id),
			unchecked: "offline",
		});
	}
	try {
		const facts = await deps.store.facts(entry.id, ref, refresh);
		return scoreServer(entry, { facts });
	} catch {
		return scoreServer(entry, {
			facts: deps.store.cached(entry.id),
			unchecked: "unreachable",
		});
	}
}

export async function serverSecurity(
	raw: unknown,
	deps: ServerSecurityDeps,
): Promise<McpSecurityScore> {
	const request = parseRequest(raw);
	const entry = (deps.catalog ?? loadMcpCatalog)().find((s) => s.id === request.serverId);
	if (!entry) throw new McpSecurityRequestError("Unknown catalog server");
	const projectPath = request.projectId ? deps.projectPath(request.projectId) : undefined;
	return scoreCatalogEntry(entry, projectPath, deps, request.refresh);
}
