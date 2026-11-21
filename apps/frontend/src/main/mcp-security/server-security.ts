/**
 * The security score the MCP Marketplace shows for a catalog server (#369).
 *
 * The renderer sends a server id, and optionally the id of the project it
 * installs into: both are checked here (S6). A project in strict offline mode
 * (`.workpilot/offline-mode.json`) gets the score from the catalog and the
 * last facts read, with no network call (S7).
 *
 * With a scan store, the score also counts the static scan of the code the
 * server runs (lot 3): read for a new version, kept for a known one, only
 * the kept one in strict offline mode. The findings the project's MCP
 * policy accepts cost nothing.
 */

import { loadMcpCatalog } from "../../shared/mcp-catalog/install";
import { scoreServer } from "../../shared/mcp-catalog/security-score";
import type {
	McpMarketplaceFailure,
	McpMarketplaceServer,
} from "../../shared/types/mcp-marketplace";
import type {
	McpRegistryFacts,
	McpSecurityRequest,
	McpSecurityScore,
} from "../../shared/types/mcp-security";
import type { McpAcceptedFinding } from "../../shared/types/mcp-code-scan";
import { packageOf, type RegistryFactsStore } from "./registry-facts";
import { codeScanFor, type SourceScanStore } from "./source-scan";

export interface ServerSecurityDeps {
	store: RegistryFactsStore;
	/** The project's folder, for a registered project id; else undefined. */
	projectPath: (projectId: string) => string | undefined;
	offline: (projectPath: string) => boolean;
	catalog?: () => McpMarketplaceServer[];
	/** The static scan of the code (lot 3); absent: not part of the score. */
	scan?: SourceScanStore;
	/** The findings the policy of the project at this path accepts. */
	accepted?: (projectPath: string) => McpAcceptedFinding[];
}

/** A request refused for a reason the renderer words (`code`). */
export class McpSecurityRequestError extends Error {
	constructor(readonly code: McpMarketplaceFailure) {
		super(code);
	}
}

function parseRequest(raw: unknown): McpSecurityRequest {
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const { serverId, projectId, refresh } = value;
	if (typeof serverId !== "string" || !serverId) {
		throw new McpSecurityRequestError("securityServerRequired");
	}
	if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
		throw new McpSecurityRequestError("securityInvalidProject");
	}
	return { serverId, projectId: projectId ?? null, refresh: refresh === true };
}

export type ScoreDeps = Pick<ServerSecurityDeps, "store" | "offline" | "scan" | "accepted">;

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
	const accepted = projectPath && deps.accepted ? deps.accepted(projectPath) : [];
	const code = async (facts: McpRegistryFacts | undefined, online: boolean) =>
		deps.scan ? { code: await codeScanFor(deps.scan, ref, facts?.version, online) } : {};
	if (projectPath && deps.offline(projectPath)) {
		const facts = deps.store.cached(entry.id);
		return scoreServer(entry, {
			facts,
			unchecked: "offline",
			...(await code(facts, false)),
			accepted,
		});
	}
	try {
		const facts = await deps.store.facts(entry.id, ref, refresh);
		return scoreServer(entry, { facts, ...(await code(facts, true)), accepted });
	} catch {
		const facts = deps.store.cached(entry.id);
		return scoreServer(entry, {
			facts,
			unchecked: "unreachable",
			...(await code(facts, false)),
			accepted,
		});
	}
}

export async function serverSecurity(
	raw: unknown,
	deps: ServerSecurityDeps,
): Promise<McpSecurityScore> {
	const request = parseRequest(raw);
	const entry = (deps.catalog ?? loadMcpCatalog)().find((s) => s.id === request.serverId);
	if (!entry) throw new McpSecurityRequestError("securityUnknownServer");
	const projectPath = request.projectId ? deps.projectPath(request.projectId) : undefined;
	return scoreCatalogEntry(entry, projectPath, deps, request.refresh);
}
