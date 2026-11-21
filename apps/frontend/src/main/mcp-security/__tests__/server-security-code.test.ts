/**
 * The score with the static scan of the code (#369, lot 3): read online,
 * the kept scan offline or when the registry is unreachable, and the
 * findings the project's policy accepts.
 */
import { describe, expect, it, vi } from "vitest";
import type { McpCodeScan } from "../../../shared/types/mcp-code-scan";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type { McpRegistryFacts } from "../../../shared/types/mcp-security";
import type { RegistryFactsStore } from "../registry-facts";
import { scoreCatalogEntry } from "../server-security";
import type { SourceScanStore } from "../source-scan";

const FACTS: McpRegistryFacts = {
	ecosystem: "npm",
	version: "1.0.0",
	lastRelease: new Date().toISOString(),
	maintainers: ["alice"],
	firstSeenMaintainers: ["alice"],
	repository: "https://github.com/demo/demo",
	vulnerabilities: [],
	checkedAt: "2026-11-15T00:00:00.000Z",
};

const SCAN: McpCodeScan = {
	status: "scanned",
	version: "1.0.0",
	files: 3,
	skipped: 0,
	findings: [{ rule: "dynamicCode", file: "index.js", line: 4, count: 1 }],
	scannedAt: "2026-11-15T00:00:00.000Z",
};

const ENTRY = {
	id: "local",
	official: true,
	author: "Demo",
	package: "demo-mcp",
	transport: "stdio",
	command: "npx",
	args: ["demo-mcp@1.0.0"],
	tools: [],
} as unknown as McpMarketplaceServer;

function deps(over: { offline?: boolean; unreachable?: boolean } = {}) {
	const store = {
		facts: vi.fn(async () => {
			if (over.unreachable) throw new Error("down");
			return FACTS;
		}),
		cached: vi.fn(() => FACTS),
	};
	const scan = { scan: vi.fn(async () => SCAN), cached: vi.fn(() => SCAN) };
	const accepted = vi.fn(() => [{ server: "local", rule: "dynamicCode" as const, reason: "plugins" }]);
	return {
		scan,
		accepted,
		deps: {
			store: store as unknown as RegistryFactsStore,
			offline: () => over.offline ?? false,
			scan: scan as unknown as SourceScanStore,
			accepted,
		},
	};
}

const codeOf = (score: Awaited<ReturnType<typeof scoreCatalogEntry>>) =>
	score.dimensions.find((d) => d.key === "code");

describe("scoreCatalogEntry with the code scan", () => {
	it("reads the code of the version the registry names, with the policy's acceptances", async () => {
		const { deps: d, scan, accepted } = deps();
		const score = await scoreCatalogEntry(ENTRY, "/projects/p1", d);
		expect(scan.scan).toHaveBeenCalledWith(
			{ ecosystem: "npm", name: "demo-mcp", version: "1.0.0" },
			"1.0.0",
		);
		expect(accepted).toHaveBeenCalledWith("/projects/p1");
		expect(codeOf(score)).toMatchObject({ points: 20, reason: "codeClean" });
		expect(score.code?.findings[0].accepted).toBe("plugins");
	});

	it("accepts nothing without a project", async () => {
		const { deps: d, accepted } = deps();
		const score = await scoreCatalogEntry(ENTRY, undefined, d);
		expect(accepted).not.toHaveBeenCalled();
		expect(codeOf(score)).toMatchObject({ points: 12, reason: "dynamicCode" });
	});

	it("uses the kept scan only, offline or when the registry is unreachable", async () => {
		for (const over of [{ offline: true }, { unreachable: true }]) {
			const { deps: d, scan } = deps(over);
			const score = await scoreCatalogEntry(ENTRY, "/projects/p1", d);
			expect(scan.scan).not.toHaveBeenCalled();
			expect(scan.cached).toHaveBeenCalled();
			expect(codeOf(score)?.status).toBe("ok");
		}
	});

	it("has no code dimension without a scan store or an accepted list", async () => {
		const { deps: d } = deps();
		const score = await scoreCatalogEntry(ENTRY, "/projects/p1", {
			store: d.store,
			offline: d.offline,
		});
		expect(codeOf(score)).toBeUndefined();
	});
});
