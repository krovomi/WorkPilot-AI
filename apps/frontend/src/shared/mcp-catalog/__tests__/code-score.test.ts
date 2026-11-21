import { describe, expect, it } from "vitest";
import type { McpCodeFinding, McpCodeScan } from "../../types/mcp-code-scan";
import type { McpMarketplaceServer } from "../../types/mcp-marketplace";
import type { McpSecurityAlert } from "../../types/mcp-security";
import { acceptedFor, CODE_MAX, codeDimension, codeReport } from "../code-score";
import { scoreServer } from "../security-score";

const AT = "2026-11-15T12:00:00.000Z";

function finding(rule: McpCodeFinding["rule"], file = "index.js", line = 3): McpCodeFinding {
	return { rule, file, line, count: 1 };
}

function scanned(...findings: McpCodeFinding[]): McpCodeScan {
	return { status: "scanned", version: "1.2.3", files: 4, skipped: 0, findings, scannedAt: AT };
}

const NONE = new Map();
const READ = new Set(["read"]);

function dim(powers: Set<string>, scan: McpCodeScan | "unknown", accepted = NONE) {
	const alerts: McpSecurityAlert[] = [];
	return { dimension: codeDimension(powers, scan, accepted, alerts), alerts };
}

describe("codeDimension", () => {
	it("counts half while the code has not been read", () => {
		expect(dim(READ, "unknown").dimension).toMatchObject({
			key: "code",
			points: CODE_MAX / 2,
			status: "unknown",
			reason: "codeUnknown",
		});
	});

	it("gives nothing, and alerts, when the code cannot be read", () => {
		const { dimension, alerts } = dim(READ, {
			status: "unavailable",
			version: "1.2.3",
			reason: "missing",
			scannedAt: AT,
		});
		expect(dimension).toMatchObject({ points: 0, status: "risk", reason: "sourceUnavailable.missing" });
		expect(alerts).toEqual([{ kind: "sourceUnavailable", values: { version: "1.2.3" } }]);
	});

	it("gives every point to clean code, network access included", () => {
		const { dimension, alerts } = dim(READ, scanned(finding("network")));
		expect(dimension).toMatchObject({ points: CODE_MAX, status: "ok", reason: "codeClean" });
		expect(dimension.values).toEqual({ files: 4, version: "1.2.3" });
		expect(alerts).toEqual([]);
	});

	it("audits permissions: commands and writes cost only when no tool declares them", () => {
		const scan = scanned(finding("shellExec"), finding("fileWrite"));
		const undeclared = dim(READ, scan);
		expect(undeclared.dimension).toMatchObject({ points: 4, status: "risk", reason: "undeclaredCommands" });
		expect(undeclared.alerts).toEqual([{ kind: "undeclaredCommands", values: { files: "index.js:3" } }]);
		expect(dim(new Set(["exec"]), scan).dimension.points).toBe(CODE_MAX);
		const writes = dim(new Set(["write"]), scan).dimension;
		expect(writes).toMatchObject({ points: 8, status: "risk", reason: "undeclaredCommands" });
		expect(dim(READ, scanned(finding("fileWrite"))).dimension).toMatchObject({
			points: 16,
			status: "warn",
			reason: "undeclaredWrites",
		});
	});

	it("penalises dynamic code and credentials, never below zero", () => {
		const scan = scanned(
			finding("shellExec"),
			finding("dynamicCode", "a.js", 1),
			finding("dynamicCode", "b.js", 2),
			finding("hardcodedSecret"),
		);
		const { dimension, alerts } = dim(READ, scan);
		expect(dimension.points).toBe(0);
		expect(alerts.map((a) => a.kind)).toEqual(["undeclaredCommands", "dynamicCode", "hardcodedSecret"]);
		expect(alerts[1].values).toEqual({ files: "a.js:1, b.js:2" });
		expect(dim(READ, scanned(finding("dynamicCode"))).dimension).toMatchObject({
			points: 12,
			status: "warn",
		});
	});

	it("does not count a finding the policy accepts", () => {
		const accepted = acceptedFor("demo", [
			{ server: "demo", rule: "dynamicCode", reason: "plugins" },
			{ server: "other", rule: "shellExec", reason: "x" },
		]);
		const { dimension, alerts } = dim(READ, scanned(finding("dynamicCode")), accepted);
		expect(dimension.points).toBe(CODE_MAX);
		expect(alerts).toEqual([]);
		expect(acceptedFor("demo")).toEqual(new Map());
	});
});

describe("codeReport", () => {
	it("marks accepted findings with their reason", () => {
		const accepted = new Map([["dynamicCode" as const, "plugins"]]);
		expect(codeReport(scanned(finding("dynamicCode"), finding("network")), accepted)).toEqual({
			version: "1.2.3",
			files: 4,
			skipped: 0,
			findings: [
				{ ...finding("dynamicCode"), accepted: "plugins" },
				finding("network"),
			],
		});
	});

	it("says why the code could not be read", () => {
		expect(
			codeReport({ status: "unavailable", version: "2.0.0", reason: "integrity", scannedAt: AT }, NONE),
		).toEqual({ version: "2.0.0", reason: "integrity", findings: [] });
	});
});

describe("scoreServer with the code scan", () => {
	const entry = {
		id: "demo",
		official: true,
		author: "Demo",
		package: "demo-mcp",
		transport: "stdio",
		command: "npx",
		args: ["-y", "demo-mcp@1.2.3"],
		tools: [{ name: "list_items", description: "" }],
	} as unknown as McpMarketplaceServer;

	it("adds the dimension and the report once the main has read the code", () => {
		const score = scoreServer(entry, {
			code: scanned(finding("dynamicCode")),
			accepted: [{ server: "demo", rule: "dynamicCode", reason: "plugins" }],
		});
		expect(score.dimensions.map((d) => d.key)).toContain("code");
		expect(score.code?.findings[0].accepted).toBe("plugins");
	});

	it("adds the dimension without a report while the code is unknown", () => {
		const score = scoreServer(entry, { code: "unknown" });
		expect(score.dimensions.at(-1)?.reason).toBe("codeUnknown");
		expect(score.code).toBeUndefined();
	});

	it("leaves the dimension out without a scan, and for a remote server", () => {
		expect(scoreServer(entry).dimensions.map((d) => d.key)).not.toContain("code");
		const remote = scoreServer({ ...entry, transport: "http" } as McpMarketplaceServer, {
			code: scanned(),
		});
		expect(remote.dimensions.map((d) => d.key)).not.toContain("code");
		expect(remote.code).toBeUndefined();
	});
});
