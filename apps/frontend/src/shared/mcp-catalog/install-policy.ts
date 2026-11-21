/**
 * The MCP install policy (`.workpilot/mcp-policy.json`, issue #369 lot 2).
 *
 * ```json
 * { "version": 1, "allowedServers": ["github", "sentry"], "minScore": 60, "blockCustomServers": true,
 *   "acceptedFindings": [{ "server": "github", "rule": "dynamicCode", "reason": "loads its own plugins" }] }
 * ```
 *
 * `acceptedFindings` (lot 3): a finding of the code scan the team reviewed
 * costs the server nothing and is shown with its reason. A reason is
 * required: an acceptance nobody explains is not one.
 *
 * Every field is optional. The schema is closed: a key it does not know, a
 * wrong type or a value out of range makes the file invalid, and an invalid
 * file is the strictest policy (nothing can be installed), said so in the
 * marketplace — a typo never loosens the policy in silence. The main process
 * reads the file (`main/mcp-security/policy-file.ts`) and applies
 * `policyRefusal` when the project's settings are written; the renderer calls
 * the same function only to hide and explain.
 */

import type { McpAcceptedFinding } from "../types/mcp-code-scan";
import type { McpMarketplaceServer } from "../types/mcp-marketplace";
import { CODE_RULES } from "./code-scan";
import type {
	McpInstallPolicy,
	McpPolicyInvalidReason,
	McpPolicyRefusal,
	McpPolicyState,
} from "../types/mcp-policy";

/** A catalog id as the policy may name it. */
export const POLICY_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_ALLOWED = 500;
const KEYS = new Set([
	"version",
	"allowedServers",
	"minScore",
	"blockCustomServers",
	"acceptedFindings",
]);
const FINDING_KEYS = new Set(["server", "rule", "reason"]);
const MAX_ACCEPTED = 200;
const MAX_REASON = 300;
/** A field name worth echoing (the file is data: anything else is not repeated). */
const FIELD = /^[A-Za-z0-9_$.-]{1,40}$/;

/** What an invalid file stands for: no server can be installed. */
export const STRICTEST_POLICY: McpInstallPolicy = {
	allowedServers: [],
	blockCustomServers: true,
};

export function invalidPolicy(
	reason: McpPolicyInvalidReason,
	field?: string,
): McpPolicyState {
	return {
		state: "invalid",
		reason,
		...(field && FIELD.test(field) ? { field } : {}),
		policy: { ...STRICTEST_POLICY, allowedServers: [] },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAcceptedFinding(value: unknown): value is McpAcceptedFinding {
	if (!isRecord(value) || Object.keys(value).some((key) => !FINDING_KEYS.has(key))) return false;
	const { server, rule, reason } = value;
	return (
		typeof server === "string" &&
		POLICY_SERVER_ID.test(server) &&
		typeof rule === "string" &&
		(CODE_RULES as readonly string[]).includes(rule) &&
		typeof reason === "string" &&
		reason.trim().length > 0 &&
		reason.length <= MAX_REASON
	);
}

/** The policy `text` (the file's content) describes. */
export function parseMcpPolicy(text: string): McpPolicyState {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return invalidPolicy("notJson");
	}
	if (!isRecord(raw)) return invalidPolicy("schema");
	const unknownKey = Object.keys(raw).find((key) => !KEYS.has(key));
	if (unknownKey !== undefined) return invalidPolicy("schema", unknownKey);

	const { version, allowedServers, minScore, blockCustomServers, acceptedFindings } = raw;
	if (version !== undefined && version !== 1) return invalidPolicy("schema", "version");
	if (
		allowedServers !== undefined &&
		!(
			Array.isArray(allowedServers) &&
			allowedServers.length <= MAX_ALLOWED &&
			allowedServers.every((id) => typeof id === "string" && POLICY_SERVER_ID.test(id))
		)
	) {
		return invalidPolicy("schema", "allowedServers");
	}
	if (
		minScore !== undefined &&
		!(typeof minScore === "number" && Number.isInteger(minScore) && minScore >= 0 && minScore <= 100)
	) {
		return invalidPolicy("schema", "minScore");
	}
	if (blockCustomServers !== undefined && typeof blockCustomServers !== "boolean") {
		return invalidPolicy("schema", "blockCustomServers");
	}
	if (
		acceptedFindings !== undefined &&
		!(
			Array.isArray(acceptedFindings) &&
			acceptedFindings.length <= MAX_ACCEPTED &&
			acceptedFindings.every(isAcceptedFinding)
		)
	) {
		return invalidPolicy("schema", "acceptedFindings");
	}
	return {
		state: "active",
		policy: {
			...(allowedServers ? { allowedServers: [...new Set(allowedServers as string[])] } : {}),
			...(minScore !== undefined ? { minScore } : {}),
			blockCustomServers: blockCustomServers === true,
			...(acceptedFindings
				? {
						acceptedFindings: (acceptedFindings as McpAcceptedFinding[]).map((a) => ({
							server: a.server,
							rule: a.rule,
							reason: a.reason.trim(),
						})),
					}
				: {}),
		},
	};
}

/** The findings an active policy accepts; none for an invalid one. */
export function acceptedFindings(state: McpPolicyState): McpAcceptedFinding[] {
	return state.state === "active" ? (state.policy.acceptedFindings ?? []) : [];
}

/** The policy needs the server's score to decide. */
export function policyNeedsScore(state: McpPolicyState): boolean {
	return state.state === "active" && state.policy.minScore !== undefined;
}

export interface PolicySubject {
	serverId: string;
	name: string;
	/** The catalog server it is (`matchCatalogServer`), or null. */
	entry: McpMarketplaceServer | null;
	/** Its security score, when the policy has a minimum. */
	score?: number;
}

/** Why `state` refuses `subject`, or null when it may be installed. */
export function policyRefusal(
	state: McpPolicyState,
	subject: PolicySubject,
): McpPolicyRefusal | null {
	if (state.state === "none") return null;
	const base = { serverId: subject.serverId, name: subject.name };
	if (state.state === "invalid") return { reason: "policyInvalid", ...base };
	const { policy } = state;
	if (!subject.entry) {
		return policy.blockCustomServers ? { reason: "customBlocked", ...base } : null;
	}
	if (policy.allowedServers && !policy.allowedServers.includes(subject.entry.id)) {
		return { reason: "notAllowed", ...base };
	}
	if (
		policy.minScore !== undefined &&
		subject.score !== undefined &&
		subject.score < policy.minScore
	) {
		return { reason: "scoreTooLow", ...base, score: subject.score, minScore: policy.minScore };
	}
	return null;
}
