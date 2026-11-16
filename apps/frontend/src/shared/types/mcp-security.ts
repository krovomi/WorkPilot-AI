/**
 * Security score of an MCP Marketplace server (issue #369).
 *
 * A score from 0 to 100, from what the catalog says of the server and what
 * its registry (npm, PyPI) and the OSV vulnerability database say of its
 * package. Computed by `shared/mcp-catalog/security-score.ts`; the registry
 * facts are fetched by the main process (`main/mcp-security/`).
 */

export type McpSecurityDimensionKey =
	| "publisher"
	| "permissions"
	| "execution"
	| "freshness"
	| "supplyChain"
	| "maintainers";

/** `ok`: nothing to say; `warn`: worth a look; `risk`: a reason not to install; `unknown`: not checked. */
export type McpSecurityStatus = "ok" | "warn" | "risk" | "unknown";

export interface McpSecurityDimension {
	key: McpSecurityDimensionKey;
	points: number;
	max: number;
	status: McpSecurityStatus;
	/** i18n key under `mcpMarketplace.security.reasons`, with its values. */
	reason: string;
	values?: Record<string, string | number>;
}

export type McpSecurityAlertKind =
	| "maintainerChanged"
	| "vulnerability"
	| "abandoned"
	| "deprecated"
	| "noSource"
	| "unpinned"
	| "executesCommands";

export interface McpSecurityAlert {
	kind: McpSecurityAlertKind;
	values?: Record<string, string | number>;
}

export type McpSecurityLevel = "high" | "medium" | "low";

export interface McpSecurityScore {
	serverId: string;
	score: number;
	level: McpSecurityLevel;
	dimensions: McpSecurityDimension[];
	alerts: McpSecurityAlert[];
	/** The registry and OSV were read (else only the catalog's facts count). */
	checked: boolean;
	/** ISO time of the registry read. */
	checkedAt?: string;
	/** Why the registry was not read: offline project, unreachable. */
	unchecked?: "offline" | "unreachable" | "remote";
}

export interface McpKnownVulnerability {
	id: string;
	summary: string;
}

/** What the registry and OSV say of a catalog server's package. */
export interface McpRegistryFacts {
	ecosystem: "npm" | "PyPI";
	version?: string;
	/** ISO date of the latest release. */
	lastRelease?: string;
	maintainers: string[];
	/** The maintainers seen the first time this package was checked here. */
	firstSeenMaintainers: string[];
	repository?: string;
	deprecated?: boolean;
	vulnerabilities: McpKnownVulnerability[];
	/** OSV could not be read: vulnerabilities unknown. */
	vulnerabilitiesUnknown?: boolean;
	checkedAt: string;
}

export interface McpSecurityRequest {
	serverId: string;
	/** The project the marketplace installs into: its offline mode is honoured. */
	projectId?: string | null;
	/** Read the registry again even when the last read is recent. */
	refresh?: boolean;
}
