/**
 * The MCP install policy of a project (issue #369, lot 2).
 *
 * An optional file, `.workpilot/mcp-policy.json`, restricts what the MCP
 * Marketplace and Agent Tools may add to the project: catalog ids allowed, a
 * minimum security score, and whether servers outside the catalog are
 * refused. The main process reads it and applies it when the project's
 * `.workpilot/.env` is written; the renderer only hides and explains.
 */

import type { McpAcceptedFinding } from "./mcp-code-scan";

/** What the file asks, once checked. */
export interface McpInstallPolicy {
	/** Catalog ids that may be installed; absent: any catalog server. */
	allowedServers?: string[];
	/** Lowest security score (0-100) a catalog server may have. */
	minScore?: number;
	/** A server that is not a catalog server, as the catalog defines it, is refused. */
	blockCustomServers: boolean;
	/** Findings of the code scan the team has reviewed, each with its reason (lot 3). */
	acceptedFindings?: McpAcceptedFinding[];
}

/** Why the file is not a policy; i18n key under `mcpMarketplace.policy.invalid`. */
export type McpPolicyInvalidReason =
	| "unreadable"
	| "notJson"
	| "schema"
	| "outsideProject"
	| "notAFile"
	| "tooLarge";

/**
 * The project's policy: none (no file), active, or invalid. An invalid file
 * is the strictest policy (nothing can be installed), and said so.
 */
export type McpPolicyState =
	| { state: "none" }
	| { state: "active"; policy: McpInstallPolicy }
	| {
			state: "invalid";
			reason: McpPolicyInvalidReason;
			/** The field of the file that is wrong, for `schema`. */
			field?: string;
			policy: McpInstallPolicy;
	  };

/** Why an install is refused; i18n key under `mcpMarketplace.policy.refusals`. */
export type McpPolicyRefusalReason =
	| "policyInvalid"
	| "notAllowed"
	| "scoreTooLow"
	| "customBlocked";

export interface McpPolicyRefusal {
	reason: McpPolicyRefusalReason;
	serverId: string;
	/** The server's name, for the sentence. */
	name: string;
	score?: number;
	minScore?: number;
}

/** What `env:update` answers when the policy refuses a server. */
export interface McpPolicyRefusalData {
	mcpPolicyRefusal: McpPolicyRefusal;
}
