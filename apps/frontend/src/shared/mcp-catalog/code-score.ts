/**
 * The « source code » dimension of the MCP security score (issue #369, lot 3).
 *
 * From the static scan of the version the server runs (`code-scan.ts`) and
 * what the catalog declares of its tools: this is also the permissions
 * audit, declared against used.
 *
 * - code that cannot be read (no archive, not found, too large, digest that
 *   does not match): 0, « cannot be audited »;
 * - starts programs while no tool of the catalog says it runs commands: −12;
 * - builds or loads code at run time: −8;
 * - holds a credential-shaped string: −8;
 * - writes files while every tool of the catalog only reads: −4.
 *
 * A finding the project's MCP policy accepts, with its reason, costs nothing
 * and is shown with that reason. Network access is shown, never counted:
 * most servers are there to call an API.
 */

import type {
	McpAcceptedFinding,
	McpCodeReport,
	McpCodeRule,
	McpCodeScan,
} from "../types/mcp-code-scan";
import type { McpSecurityAlert, McpSecurityDimension } from "../types/mcp-security";

export const CODE_MAX = 20;

interface Penalty {
	rule: McpCodeRule;
	points: number;
	reason: string;
	alert?: McpSecurityAlert["kind"];
	/** The rule costs only when the catalog does not declare the power. */
	undeclared?: (powers: ReadonlySet<string>) => boolean;
}

const PENALTIES: Penalty[] = [
	{
		rule: "shellExec",
		points: 12,
		reason: "undeclaredCommands",
		alert: "undeclaredCommands",
		undeclared: (powers) => !powers.has("exec"),
	},
	{ rule: "dynamicCode", points: 8, reason: "dynamicCode", alert: "dynamicCode" },
	{ rule: "hardcodedSecret", points: 8, reason: "hardcodedSecret", alert: "hardcodedSecret" },
	{
		rule: "fileWrite",
		points: 4,
		reason: "undeclaredWrites",
		undeclared: (powers) => !powers.has("exec") && !powers.has("write"),
	},
];

/** What the details show of the scan, accepted findings marked with their reason. */
export function codeReport(scan: McpCodeScan, accepted: Map<McpCodeRule, string>): McpCodeReport {
	if (scan.status === "unavailable") {
		return { version: scan.version, reason: scan.reason, findings: [] };
	}
	return {
		version: scan.version,
		files: scan.files,
		skipped: scan.skipped,
		findings: scan.findings.map((f) => {
			const reason = accepted.get(f.rule);
			return reason ? { ...f, accepted: reason } : f;
		}),
	};
}

export function acceptedFor(
	serverId: string,
	accepted: readonly McpAcceptedFinding[] = [],
): Map<McpCodeRule, string> {
	return new Map(accepted.filter((a) => a.server === serverId).map((a) => [a.rule, a.reason]));
}

/**
 * The dimension, its alerts pushed on `alerts`. `scan` "unknown": the main
 * tried and could not read it (network): half the points, not checked.
 */
export function codeDimension(
	/** What the catalog's tools can do (`toolPower` of each). */
	powers: ReadonlySet<string>,
	scan: McpCodeScan | "unknown",
	accepted: Map<McpCodeRule, string>,
	alerts: McpSecurityAlert[],
): McpSecurityDimension {
	const base = { key: "code" as const, max: CODE_MAX };
	if (scan === "unknown") {
		return { ...base, points: CODE_MAX / 2, status: "unknown", reason: "codeUnknown" };
	}
	if (scan.status === "unavailable") {
		alerts.push({ kind: "sourceUnavailable", values: { version: scan.version } });
		return {
			...base,
			points: 0,
			status: "risk",
			reason: `sourceUnavailable.${scan.reason}`,
			values: { version: scan.version },
		};
	}
	let points = CODE_MAX;
	let reason = "codeClean";
	for (const penalty of PENALTIES) {
		if (accepted.has(penalty.rule)) continue;
		const found = scan.findings.filter((f) => f.rule === penalty.rule);
		if (!found.length || (penalty.undeclared && !penalty.undeclared(powers))) continue;
		points -= penalty.points;
		if (reason === "codeClean") reason = penalty.reason;
		if (penalty.alert) {
			const files = found.map((f) => `${f.file}:${f.line}`).slice(0, 3).join(", ");
			alerts.push({ kind: penalty.alert, values: { files } });
		}
	}
	points = Math.max(0, points);
	const status = points === CODE_MAX ? "ok" : points >= CODE_MAX / 2 ? "warn" : "risk";
	return {
		...base,
		points,
		status,
		reason,
		values: { files: scan.files, version: scan.version },
	};
}
