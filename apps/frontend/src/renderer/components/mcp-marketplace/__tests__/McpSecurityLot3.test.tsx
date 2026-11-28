/** @vitest-environment jsdom */
/**
 * What the marketplace shows of the static scan of a server's code (#369,
 * lot 3): the code dimension and its findings, accepted ones with their
 * reason; a new rule raised by the daily check, by its name; the accepted
 * findings of the policy; a refusal of the policy outside the marketplace.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scoreServer } from "../../../../shared/mcp-catalog/security-score";
import type { McpCodeReport, McpCodeScan } from "../../../../shared/types/mcp-code-scan";
import type { McpMarketplaceServer } from "../../../../shared/types/mcp-marketplace";
import type { McpRegistryFacts } from "../../../../shared/types/mcp-security";
import { useMcpMarketplaceStore } from "../../../stores/mcp-marketplace-store";
import { McpCodeScanDetails } from "../McpCodeScanDetails";
import { McpWatchDetails } from "../McpInstalledAlerts";
import { McpPolicyBanner, McpPolicyRefusalNotice } from "../McpPolicyNotice";
import { McpSecurityDetails, useMcpServerSecurity } from "../McpSecurityScore";
import { CATALOG, type MainApi, resetWorld } from "./mcp-world";

const local = CATALOG.find((s) => s.transport === "stdio" && s.command === "npx") as McpMarketplaceServer;

const FACTS: McpRegistryFacts = {
	ecosystem: "npm",
	version: "1.0.0",
	lastRelease: new Date().toISOString(),
	maintainers: ["alice"],
	firstSeenMaintainers: ["alice"],
	repository: "https://github.com/demo/demo",
	vulnerabilities: [],
	checkedAt: "2026-11-15T10:00:00.000Z",
};

const SCAN: McpCodeScan = {
	status: "scanned",
	version: "1.0.0",
	files: 12,
	skipped: 2,
	findings: [
		{ rule: "dynamicCode", file: "dist/plugins.js", line: 40, count: 3 },
		{ rule: "network", file: "dist/api.js", line: 9, count: 1 },
	],
	scannedAt: "2026-11-15T10:00:00.000Z",
};

let api: MainApi;

beforeEach(async () => {
	api = await resetWorld();
});

afterEach(cleanup);

function Harness() {
	return <McpSecurityDetails security={useMcpServerSecurity(local, "p1")} />;
}

describe("the code scan in the score's details", () => {
	it("shows the code dimension, its alert and each finding", async () => {
		api.getMcpServerSecurity.mockResolvedValue({
			success: true,
			data: scoreServer(local, { facts: FACTS, code: SCAN }),
		});
		render(<Harness />);
		const scan = await screen.findByTestId("mcp-code-scan");
		expect(scan).toHaveTextContent("Code scan of version 1.0.0: 12 source files");
		expect(scan).toHaveTextContent("2 files were too large or beyond the limit and were not read.");
		expect(scan).toHaveTextContent("Dynamic code");
		expect(scan).toHaveTextContent("dist/plugins.js:40");
		expect(scan).toHaveTextContent("and 2 more matches");
		expect(scan).toHaveTextContent("Network access");
		expect(screen.getByText(/^Source code \d+\/20$/)).toBeInTheDocument();
		expect(screen.getByTestId("mcp-security-alerts")).toHaveTextContent(
			"Runs code built or loaded at run time (dist/plugins.js:40)",
		);
	});

	it("says why the code cannot be audited, without a findings list", async () => {
		api.getMcpServerSecurity.mockResolvedValue({
			success: true,
			data: scoreServer(local, {
				facts: FACTS,
				code: { status: "unavailable", version: "1.0.0", reason: "integrity", scannedAt: FACTS.checkedAt },
			}),
		});
		render(<Harness />);
		expect(
			await screen.findByText(
				"The archive of version 1.0.0 does not match the registry's digest: its code cannot be audited.",
			),
		).toBeInTheDocument();
		expect(screen.queryByTestId("mcp-code-scan")).toBeNull();
	});
});

describe("McpCodeScanDetails", () => {
	it("marks an accepted finding with the policy's reason", () => {
		const report: McpCodeReport = {
			version: "2.0.0",
			files: 1,
			findings: [{ rule: "shellExec", file: "a.js", line: 1, count: 1, accepted: "runs git only" }],
		};
		render(<McpCodeScanDetails report={report} />);
		const scan = screen.getByTestId("mcp-code-scan");
		expect(scan).toHaveTextContent("Starts programs");
		expect(scan).toHaveTextContent("accepted by the project's MCP policy: runs git only");
		expect(scan).not.toHaveTextContent("more match");
		expect(scan).not.toHaveTextContent("not read");
	});

	it("says when nothing was found, and counts no file it did not read", () => {
		render(<McpCodeScanDetails report={{ version: "2.0.0", findings: [] }} />);
		expect(screen.getByTestId("mcp-code-scan")).toHaveTextContent(
			"Code scan of version 2.0.0: 0 source files",
		);
		expect(screen.getByText("No pattern found.")).toBeInTheDocument();
	});
});

describe("the daily check's code alerts", () => {
	it("names the rule a new version brings", () => {
		render(
			<McpWatchDetails
				projectId="p1"
				watch={{
					serverId: "gitlab",
					status: "watched",
					alerts: [
						{
							id: "code:shellExec:2.0.0",
							kind: "newCodeFinding",
							values: { rule: "shellExec", version: "2.0.0", file: "index.js:7" },
							detectedAt: "2026-11-20T10:00:00.000Z",
						},
						{
							id: "code-unavailable:2.0.0",
							kind: "sourceUnavailable",
							values: { version: "2.0.0" },
							detectedAt: "2026-11-20T10:00:00.000Z",
						},
					],
				}}
			/>,
		);
		expect(
			screen.getByText(/Version 2.0.0 brings code that the previous one did not have: Starts programs \(index.js:7\)/),
		).toBeInTheDocument();
		expect(screen.getByText(/The code of version 2.0.0 can no longer be read/)).toBeInTheDocument();
	});
});

describe("the policy", () => {
	it("says how many findings it accepts", () => {
		useMcpMarketplaceStore.setState({
			policyProjectId: "p1",
			policy: {
				state: "active",
				policy: {
					blockCustomServers: false,
					acceptedFindings: [{ server: "github", rule: "dynamicCode", reason: "reviewed" }],
				},
			},
		});
		render(<McpPolicyBanner projectId="p1" />);
		expect(
			screen.getByText("1 finding of the code scan accepted, with its reason."),
		).toBeInTheDocument();
	});

	it("says why it refused a save made outside the marketplace", () => {
		render(
			<McpPolicyRefusalNotice
				refusal={{ reason: "customBlocked", serverId: "mine", name: "Mine" }}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"The project's MCP policy refuses servers outside the catalog (Mine).",
		);
	});
});
