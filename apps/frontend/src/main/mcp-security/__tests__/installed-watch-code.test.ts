/**
 * @vitest-environment node
 *
 * The daily check and the static scan (#369, lot 3): a new version that
 * trips a risky rule the previous one did not, or whose code can no longer
 * be read, raises an alert once; the first scan only sets the baseline.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalogServer, loadMcpCatalog } from "../../../shared/mcp-catalog/install";
import type { McpCodeFinding, McpCodeScan } from "../../../shared/types/mcp-code-scan";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type { McpRegistryFacts } from "../../../shared/types/mcp-security";
import {
	baselineOf,
	InstalledWatchStore,
	runInstalledWatch,
	type WatchBaseline,
	worsened,
} from "../installed-watch";
import type { RegistryFactsStore } from "../registry-facts";
import type { SourceScanStore } from "../source-scan";

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const AT = new Date(NOW).toISOString();

const FACTS: McpRegistryFacts = {
	ecosystem: "npm",
	version: "2.0.0",
	lastRelease: AT,
	maintainers: ["alice"],
	firstSeenMaintainers: ["alice"],
	repository: "https://github.com/demo/demo",
	vulnerabilities: [],
	checkedAt: AT,
};

const BASE: WatchBaseline = {
	version: "1.0.0",
	vulnerabilities: [],
	maintainers: ["alice"],
	deprecated: false,
	score: 80,
	checkedAt: "2026-11-19T10:00:00.000Z",
	codeRules: ["network"],
};

const f = (rule: McpCodeFinding["rule"]): McpCodeFinding => ({ rule, file: "index.js", line: 7, count: 1 });

function scanned(...findings: McpCodeFinding[]): McpCodeScan {
	return { status: "scanned", version: "2.0.0", files: 2, skipped: 0, findings, scannedAt: AT };
}

const UNAVAILABLE: McpCodeScan = { status: "unavailable", version: "2.0.0", reason: "missing", scannedAt: AT };

describe("worsened, with the code scan", () => {
	it("raises a risky rule the previous version did not trip, once per rule", () => {
		const alerts = worsened(BASE, FACTS, 80, AT, scanned(f("network"), f("fileWrite"), f("shellExec"), f("dynamicCode")));
		expect(alerts).toEqual([
			{
				id: "code:shellExec:2.0.0",
				kind: "newCodeFinding",
				values: { rule: "shellExec", version: "2.0.0", file: "index.js:7" },
				detectedAt: AT,
			},
			expect.objectContaining({ id: "code:dynamicCode:2.0.0" }),
		]);
		expect(worsened({ ...BASE, codeRules: ["shellExec"] }, FACTS, 80, AT, scanned(f("shellExec")))).toEqual([]);
	});

	it("says nothing before a first scan, or while the code is unknown", () => {
		const { codeRules: _rules, ...first } = BASE;
		expect(worsened(first, FACTS, 80, AT, scanned(f("shellExec")))).toEqual([]);
		expect(worsened(BASE, FACTS, 80, AT, "unknown")).toEqual([]);
		expect(worsened(BASE, FACTS, 80, AT)).toEqual([]);
	});

	it("raises code that can no longer be read, once", () => {
		expect(worsened(BASE, FACTS, 80, AT, UNAVAILABLE)).toEqual([
			{ id: "code-unavailable:2.0.0", kind: "sourceUnavailable", values: { version: "2.0.0" }, detectedAt: AT },
		]);
		expect(worsened({ ...BASE, codeUnavailable: true }, FACTS, 80, AT, UNAVAILABLE)).toEqual([]);
	});
});

describe("baselineOf, with the code scan", () => {
	it("keeps the rules of the version scanned", () => {
		const base = baselineOf(FACTS, 80, { ...BASE, codeUnavailable: true }, scanned(f("shellExec"), f("network"), f("network")));
		expect(base.codeRules).toEqual(["network", "shellExec"]);
		expect(base.codeUnavailable).toBeUndefined();
	});

	it("keeps what it knew while the code is unknown, and marks code it cannot read", () => {
		const previous = { ...BASE, codeUnavailable: true };
		expect(baselineOf(FACTS, 80, previous, "unknown")).toMatchObject({ codeRules: ["network"], codeUnavailable: true });
		expect(baselineOf(FACTS, 80, BASE)).toMatchObject({ codeRules: ["network"] });
		expect(baselineOf(FACTS, 80, BASE).codeUnavailable).toBeUndefined();
		expect(baselineOf(FACTS, 80, undefined, "unknown").codeRules).toBeUndefined();
		expect(baselineOf(FACTS, 80, BASE, UNAVAILABLE)).toMatchObject({ codeRules: ["network"], codeUnavailable: true });
		expect(baselineOf(FACTS, 80, undefined, UNAVAILABLE).codeRules).toBeUndefined();
	});
});

describe("runInstalledWatch, with the code scan", () => {
	let dir: string;
	let watch: InstalledWatchStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-watch-code-"));
		watch = new InstalledWatchStore(path.join(dir, "installed-watch.json"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("scans the version the registry names, and alerts on the next new rule", async () => {
		const catalog = loadMcpCatalog();
		const gitlab = catalog.find((s) => s.id === "gitlab") as McpMarketplaceServer;
		const built = buildCatalogServer(gitlab, Object.fromEntries(gitlab.vars.map((v) => [v.name, "x"])));
		if (!built.ok) throw new Error("gitlab");
		let code = scanned(f("network"));
		const scan = { scan: vi.fn(async () => code), cached: vi.fn() };
		const deps = (now: number) => ({
			projects: () => [{ id: "p1", path: "/projects/p1" }],
			installed: () => [built.server],
			offline: () => false,
			catalog: () => catalog,
			facts: { facts: async () => FACTS } as unknown as RegistryFactsStore,
			scan: scan as unknown as SourceScanStore,
			watch,
			now: () => now,
		});
		expect(await runInstalledWatch(deps(NOW))).toBe(0);
		expect(scan.scan).toHaveBeenCalledWith({ ecosystem: "npm", name: "@zereight/mcp-gitlab" }, "2.0.0");
		expect(watch.read().servers.gitlab.baseline?.codeRules).toEqual(["network"]);

		code = scanned(f("network"), f("dynamicCode"));
		expect(await runInstalledWatch(deps(NOW + 86_400_000))).toBe(1);
		expect(watch.read().servers.gitlab.alerts[0].kind).toBe("newCodeFinding");
	});
});
