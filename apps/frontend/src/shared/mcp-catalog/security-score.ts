/**
 * The security score of an MCP Marketplace server (issue #369).
 *
 * Six dimensions, each worth some points; the score is the share of the
 * points that apply, from 0 to 100. A remote server (http, sse) has no
 * package on this machine: freshness, supply chain and maintainers do not
 * apply to it, and its score is out of the other three.
 *
 * - publisher: maintained by the vendor of the product, or by the community;
 * - permissions: what its tools can do (read, write, run commands), and a
 *   read-only flag in its launch arguments;
 * - execution: runs on this machine with your rights (stdio) or elsewhere,
 *   and whether its version is pinned or fetched afresh at each start;
 * - freshness: the date of its latest release (more than six months:
 *   possibly abandoned);
 * - supply chain: the known vulnerabilities of its version (OSV);
 * - maintainers: a change of maintainers since it was first checked here
 *   (account takeover), a package without a source repository.
 *
 * No model, no network here: the registry facts are read by the main
 * process, and without them each of their dimensions counts half.
 *
 * A seventh dimension, the static scan of the code it runs (`code-score.ts`,
 * lot 3), counts once the main has read that code.
 */

import type { McpAcceptedFinding, McpCodeScan } from "../types/mcp-code-scan";
import type { McpMarketplaceServer } from "../types/mcp-marketplace";
import type {
	McpRegistryFacts,
	McpSecurityAlert,
	McpSecurityDimension,
	McpSecurityLevel,
	McpSecurityScore,
} from "../types/mcp-security";
import { acceptedFor, CODE_MAX, codeDimension, codeReport } from "./code-score";

const MAX = {
	publisher: 20,
	permissions: 20,
	execution: 15,
	freshness: 15,
	supplyChain: 20,
	maintainers: 10,
	code: CODE_MAX,
} as const;

/** More than this without a release: possibly abandoned. */
export const ABANDONED_DAYS = 183;
const DAY_MS = 86_400_000;

const EXEC_TOOL =
	/(^|_|-)(run|exec|execute|shell|command|eval|script|deploy|apply|kubectl|terminal)(_|-|$)/i;
const WRITE_TOOL =
	/(^|_|-)(create|update|delete|write|push|merge|send|post|set|remove|upload|modify|edit|move|rename|insert|drop|add|patch|put|close|comment|navigate|click|fill|type)(_|-|$)/i;
const READ_ONLY_FLAG = /^--?(read-?only|readonly|access-mode=restricted)$/i;

/** What a tool can do, from its name. */
export function toolPower(name: string): "exec" | "write" | "read" {
	if (EXEC_TOOL.test(name)) return "exec";
	if (WRITE_TOOL.test(name)) return "write";
	return "read";
}

/** The launch arguments pin the package to one version. */
export function isPinned(entry: McpMarketplaceServer): boolean {
	const pkg = entry.package;
	return (entry.args ?? []).some((arg) => {
		if (!arg.startsWith(pkg) || arg.length === pkg.length) return false;
		const rest = arg.slice(pkg.length);
		const version = rest.startsWith("@") || rest.startsWith("==") ? rest.replace(/^(@|==)/, "") : "";
		return /^\d+\.\d+(\.\d+)?$/.test(version);
	});
}

function dimension(
	key: McpSecurityDimension["key"],
	points: number,
	status: McpSecurityDimension["status"],
	reason: string,
	values?: McpSecurityDimension["values"],
): McpSecurityDimension {
	return { key, points, max: MAX[key], status, reason, ...(values ? { values } : {}) };
}

function publisher(entry: McpMarketplaceServer): McpSecurityDimension {
	return entry.official
		? dimension("publisher", MAX.publisher, "ok", "official", { author: entry.author })
		: dimension("publisher", 8, "warn", "community", { author: entry.author });
}

function permissions(
	entry: McpMarketplaceServer,
	alerts: McpSecurityAlert[],
): McpSecurityDimension {
	const powers = entry.tools.map((tool) => toolPower(tool.name));
	const readOnly = (entry.args ?? []).some((arg) => READ_ONLY_FLAG.test(arg));
	const exec = entry.tools.filter((_tool, i) => powers[i] === "exec").map((t) => t.name);
	if (exec.length && !readOnly) {
		alerts.push({ kind: "executesCommands", values: { tools: exec.join(", ") } });
		return dimension("permissions", 5, "risk", "executes", { tools: exec.join(", ") });
	}
	if (readOnly) return dimension("permissions", 17, "ok", "readOnlyFlag");
	if (powers.includes("write")) return dimension("permissions", 12, "warn", "writes");
	return dimension("permissions", MAX.permissions, "ok", "readsOnly");
}

function execution(
	entry: McpMarketplaceServer,
	alerts: McpSecurityAlert[],
): McpSecurityDimension {
	if (entry.transport !== "stdio") {
		return dimension("execution", MAX.execution, "ok", "remote");
	}
	if (isPinned(entry)) return dimension("execution", 11, "ok", "localPinned");
	alerts.push({ kind: "unpinned" });
	return dimension("execution", 7, "warn", "localUnpinned");
}

function freshness(
	facts: McpRegistryFacts | undefined,
	now: number,
	alerts: McpSecurityAlert[],
): McpSecurityDimension {
	const released = facts?.lastRelease ? Date.parse(facts.lastRelease) : Number.NaN;
	if (!facts || Number.isNaN(released)) {
		return dimension("freshness", 7, "unknown", "unknown");
	}
	const days = Math.max(0, Math.floor((now - released) / DAY_MS));
	if (facts.deprecated) {
		alerts.push({ kind: "deprecated" });
		return dimension("freshness", 0, "risk", "deprecated", { days });
	}
	if (days > ABANDONED_DAYS) {
		alerts.push({ kind: "abandoned", values: { days } });
		return dimension("freshness", 4, "warn", "stale", { days });
	}
	return dimension("freshness", MAX.freshness, "ok", "recent", { days });
}

function supplyChain(
	facts: McpRegistryFacts | undefined,
	alerts: McpSecurityAlert[],
): McpSecurityDimension {
	if (!facts || facts.vulnerabilitiesUnknown) {
		return dimension("supplyChain", 10, "unknown", "unknown");
	}
	const count = facts.vulnerabilities.length;
	for (const vuln of facts.vulnerabilities) {
		alerts.push({ kind: "vulnerability", values: { id: vuln.id, summary: vuln.summary } });
	}
	if (count) return dimension("supplyChain", 0, "risk", "vulnerable", { count });
	return dimension("supplyChain", MAX.supplyChain, "ok", "noKnownVulnerability", {
		version: facts.version ?? "",
	});
}

function maintainers(
	facts: McpRegistryFacts | undefined,
	alerts: McpSecurityAlert[],
): McpSecurityDimension {
	if (!facts) return dimension("maintainers", 5, "unknown", "unknown");
	const first = new Set(facts.firstSeenMaintainers);
	const added = facts.maintainers.filter((name) => !first.has(name));
	if (first.size && added.length) {
		alerts.push({ kind: "maintainerChanged", values: { names: added.join(", ") } });
		return dimension("maintainers", 0, "risk", "changed", { names: added.join(", ") });
	}
	if (!facts.repository) {
		alerts.push({ kind: "noSource" });
		return dimension("maintainers", 3, "warn", "noSource");
	}
	return dimension("maintainers", MAX.maintainers, "ok", "stable", {
		count: facts.maintainers.length,
	});
}

export function securityLevel(score: number): McpSecurityLevel {
	if (score >= 75) return "high";
	if (score >= 50) return "medium";
	return "low";
}

export interface ScoreOptions {
	facts?: McpRegistryFacts;
	unchecked?: McpSecurityScore["unchecked"];
	now?: number;
	/**
	 * The scan of the code it runs; "unknown": tried and not read. Absent:
	 * not part of this score (the renderer's estimate).
	 */
	code?: McpCodeScan | "unknown";
	/** The findings the project's MCP policy accepts. */
	accepted?: readonly McpAcceptedFinding[];
}

/** The score of a catalog server, with or without its registry facts. */
export function scoreServer(
	entry: McpMarketplaceServer,
	options: ScoreOptions = {},
): McpSecurityScore {
	const { facts, now = Date.now() } = options;
	const alerts: McpSecurityAlert[] = [];
	const dimensions = [publisher(entry), permissions(entry, alerts), execution(entry, alerts)];
	const remote = entry.transport !== "stdio";
	if (!remote) {
		dimensions.push(
			freshness(facts, now, alerts),
			supplyChain(facts, alerts),
			maintainers(facts, alerts),
		);
	}
	const { code } = options;
	const accepted = acceptedFor(entry.id, options.accepted);
	if (!remote && code) {
		const powers = new Set(entry.tools.map((tool) => toolPower(tool.name)));
		dimensions.push(codeDimension(powers, code, accepted, alerts));
	}
	const earned = dimensions.reduce((sum, d) => sum + d.points, 0);
	const max = dimensions.reduce((sum, d) => sum + d.max, 0);
	const score = Math.round((100 * earned) / max);
	return {
		serverId: entry.id,
		score,
		level: securityLevel(score),
		dimensions,
		alerts,
		checked: Boolean(facts),
		...(facts ? { checkedAt: facts.checkedAt } : {}),
		...(!remote && code && code !== "unknown" ? { code: codeReport(code, accepted) } : {}),
		...(remote ? { unchecked: "remote" as const } : options.unchecked ? { unchecked: options.unchecked } : {}),
	};
}
