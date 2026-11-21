/**
 * @vitest-environment node
 *
 * The daily check of installed servers: at most once a day, only catalog
 * servers as the catalog defines them, never a project in strict offline
 * mode; what got worse since the last reading becomes an alert raised once,
 * kept until acknowledged.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalogServer, loadMcpCatalog } from "../../../shared/mcp-catalog/install";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type { McpRegistryFacts } from "../../../shared/types/mcp-security";
import {
	baselineOf,
	InstalledWatchStore,
	installedWatchView,
	McpWatchRequestError,
	parseAcknowledgeRequest,
	parseWatchRequest,
	runInstalledWatch,
	type WatchBaseline,
	type WatchDeps,
	worsened,
} from "../installed-watch";
import type { RegistryFactsStore } from "../registry-facts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const catalog = loadMcpCatalog();
const entry = (id: string) => catalog.find((s) => s.id === id) as McpMarketplaceServer;
const installed = (id: string) => {
	const e = entry(id);
	const built = buildCatalogServer(e, Object.fromEntries(e.vars.map((v) => [v.name, "x"])));
	if (!built.ok) throw new Error(id);
	return built.server;
};

const FACTS: McpRegistryFacts = {
	ecosystem: "npm",
	version: "1.0.0",
	lastRelease: new Date(NOW - DAY).toISOString(),
	maintainers: ["alice"],
	firstSeenMaintainers: ["alice"],
	repository: "https://github.com/demo/demo",
	vulnerabilities: [],
	checkedAt: new Date(NOW).toISOString(),
};

const BASE: WatchBaseline = {
	version: "1.0.0",
	vulnerabilities: ["OLD-1"],
	maintainers: ["alice"],
	deprecated: false,
	score: 80,
	checkedAt: "2026-11-19T10:00:00.000Z",
};

let dir: string;
let watch: InstalledWatchStore;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-watch-"));
	watch = new InstalledWatchStore(path.join(dir, "sub", "installed-watch.json"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<WatchDeps> & { readFacts?: () => Promise<McpRegistryFacts> } = {}) {
	const facts = { facts: vi.fn(over.readFacts ?? (async () => FACTS)) };
	const d: WatchDeps = {
		projects: () => [
			{ id: "p1", path: "/projects/p1" },
			{ id: "p2", path: "/projects/air" },
			{ id: "p3", path: "" },
		],
		installed: (project) =>
			project.id === "p1"
				? [installed("gitlab"), installed("github"), { id: "mine", type: "command", command: "node" }]
				: [installed("git")],
		offline: (p) => p === "/projects/air",
		catalog: () => catalog,
		facts: facts as unknown as RegistryFactsStore,
		watch,
		now: () => NOW,
		...over,
	};
	return { d, facts };
}

describe("worsened", () => {
	const at = "2026-11-20T10:00:00.000Z";

	it("finds nothing when nothing got worse", () => {
		expect(worsened(BASE, { ...FACTS, vulnerabilities: [{ id: "OLD-1", summary: "x" }] }, 80, at)).toEqual([]);
	});

	it("raises a new advisory, a new maintainer, a deprecation and a fall below 50", () => {
		const facts: McpRegistryFacts = {
			...FACTS,
			vulnerabilities: [
				{ id: "OLD-1", summary: "known" },
				{ id: "GHSA-new", summary: "Remote code execution" },
			],
			maintainers: ["alice", "mallory"],
			deprecated: true,
		};
		expect(worsened(BASE, facts, 40, at)).toEqual([
			{
				id: "vuln:GHSA-new",
				kind: "newVulnerability",
				values: { id: "GHSA-new", summary: "Remote code execution", version: "1.0.0" },
				detectedAt: at,
			},
			{ id: "maintainers:mallory", kind: "maintainerAdded", values: { names: "mallory" }, detectedAt: at },
			{ id: "deprecated:1.0.0", kind: "deprecated", values: { version: "1.0.0" }, detectedAt: at },
			{ id: `low:${FACTS.checkedAt}`, kind: "lowScore", values: { score: 40, previous: 80 }, detectedAt: at },
		]);
	});

	it("says nothing it cannot compare: OSV unknown then or now, no maintainer before, no version", () => {
		const unknownNow = { ...FACTS, vulnerabilities: [], vulnerabilitiesUnknown: true };
		expect(worsened(BASE, unknownNow, 80, at)).toEqual([]);
		const neverKnown = { ...BASE, vulnerabilities: undefined, maintainers: [] };
		const facts = { ...FACTS, vulnerabilities: [{ id: "X", summary: "" }], maintainers: ["bob"] };
		expect(worsened(neverKnown, facts, 80, at)).toEqual([]);
		const noVersion = { ...FACTS, version: undefined, deprecated: true, vulnerabilities: [{ id: "Y", summary: "s" }] };
		expect(worsened(BASE, noVersion, 60, at).map((a) => a.values?.version)).toEqual(["", ""]);
		expect(worsened({ ...BASE, score: 45 }, FACTS, 30, at)).toEqual([]);
		expect(worsened({ ...BASE, deprecated: true }, { ...FACTS, deprecated: true }, 80, at)).toEqual([]);
	});
});

describe("baselineOf", () => {
	it("keeps the advisories it knew when OSV did not answer", () => {
		const unknown = { ...FACTS, version: undefined, vulnerabilitiesUnknown: true };
		expect(baselineOf(unknown, 70, BASE)).toEqual({
			vulnerabilities: ["OLD-1"],
			maintainers: ["alice"],
			deprecated: false,
			score: 70,
			checkedAt: FACTS.checkedAt,
		});
		expect(baselineOf(unknown, 70).vulnerabilities).toBeUndefined();
		expect(baselineOf({ ...FACTS, deprecated: true }, 10).vulnerabilities).toEqual([]);
	});
});

describe("runInstalledWatch", () => {
	it("reads installed catalog packages only, never an offline project, and sets a baseline", async () => {
		const { d, facts } = deps();
		expect(await runInstalledWatch(d)).toBe(0);
		// gitlab (npx) from p1; github is remote, mine is not a catalog server,
		// git is only in the strict offline project.
		expect(facts.facts).toHaveBeenCalledTimes(1);
		expect(facts.facts).toHaveBeenCalledWith("gitlab", { ecosystem: "npm", name: "@zereight/mcp-gitlab" });
		const saved = watch.read();
		expect(saved.lastRun).toBe(new Date(NOW).toISOString());
		expect(saved.servers.gitlab.baseline?.maintainers).toEqual(["alice"]);
		expect(saved.servers.gitlab.alerts).toEqual([]);
	});

	it("runs at most once a day", async () => {
		const { d, facts } = deps();
		watch.write({ lastRun: new Date(NOW - DAY + 60_000).toISOString(), servers: {} });
		expect(await runInstalledWatch(d)).toBeNull();
		expect(facts.facts).not.toHaveBeenCalled();
		watch.write({ lastRun: new Date(NOW - DAY).toISOString(), servers: {} });
		expect(await runInstalledWatch(d)).toBe(0);
	});

	it("raises what got worse once, and keeps it until acknowledged", async () => {
		watch.write({ servers: { gitlab: { baseline: BASE, alerts: [] } } });
		const worse = { ...FACTS, vulnerabilities: [{ id: "GHSA-1", summary: "bad" }] };
		const { d } = deps({ readFacts: async () => worse });
		expect(await runInstalledWatch(d)).toBe(1);

		const later = deps({ readFacts: async () => worse, now: () => NOW + DAY });
		watch.write({
			...watch.read(),
			servers: { gitlab: { ...watch.read().servers.gitlab, baseline: BASE } },
		});
		expect(await runInstalledWatch(later.d)).toBe(0);
		expect(watch.read().servers.gitlab.alerts).toHaveLength(1);

		expect(watch.acknowledge("gitlab", NOW)).toBe(true);
		expect(watch.read().servers.gitlab.alerts[0].acknowledgedAt).toBe(new Date(NOW).toISOString());
		expect(watch.acknowledge("gitlab", NOW)).toBe(false);
		expect(watch.acknowledge("unknown", NOW)).toBe(false);
	});

	it("keeps at most 50 alerts a server", async () => {
		const old = Array.from({ length: 50 }, (_, i) => ({
			id: `vuln:OLD-${i}`,
			kind: "newVulnerability" as const,
			detectedAt: "2026-01-01T00:00:00.000Z",
		}));
		watch.write({ servers: { gitlab: { baseline: { ...BASE, vulnerabilities: [] }, alerts: old } } });
		const { d } = deps({ readFacts: async () => ({ ...FACTS, vulnerabilities: [{ id: "N", summary: "" }] }) });
		expect(await runInstalledWatch(d)).toBe(1);
		const alerts = watch.read().servers.gitlab.alerts;
		expect(alerts).toHaveLength(50);
		expect(alerts.at(-1)?.id).toBe("vuln:N");
	});

	it("skips a registry that does not answer, and says so in the log", async () => {
		const warn = vi.fn();
		const { d } = deps({
			readFacts: async () => {
				throw new Error("HTTP 503");
			},
			warn,
		});
		expect(await runInstalledWatch(d)).toBe(0);
		expect(warn).toHaveBeenCalledWith("[MCP watch] gitlab: HTTP 503");
		expect(watch.read().servers.gitlab).toBeUndefined();

		const quiet = deps({
			readFacts: async () => {
				throw "down";
			},
			warn,
		});
		watch.write({ servers: {} });
		expect(await runInstalledWatch(quiet.d)).toBe(0);
		expect(warn).toHaveBeenLastCalledWith("[MCP watch] gitlab: down");

		const silent = deps({
			readFacts: async () => {
				throw new Error("x");
			},
		});
		watch.write({ servers: {} });
		expect(await runInstalledWatch(silent.d)).toBe(0);
	});

	it("uses the clock by default", async () => {
		const { d } = deps({ now: undefined });
		expect(await runInstalledWatch(d)).toBe(0);
		expect(watch.read().lastRun).toBeDefined();
	});
});

describe("InstalledWatchStore", () => {
	it("reads a missing or broken file as empty", () => {
		expect(watch.read()).toEqual({ servers: {} });
		fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
		fs.writeFileSync(path.join(dir, "sub", "installed-watch.json"), "[1]");
		expect(watch.read()).toEqual({ servers: {} });
		fs.writeFileSync(path.join(dir, "sub", "installed-watch.json"), '{"lastRun": 3, "servers": []}');
		expect(watch.read()).toEqual({ servers: {} });
	});
});

describe("installedWatchView", () => {
	it("gives each installed server its status and its open alerts", () => {
		watch.write({
			lastRun: "2026-11-20T00:00:00.000Z",
			servers: {
				gitlab: {
					baseline: BASE,
					alerts: [
						{ id: "a", kind: "deprecated", detectedAt: "2026-11-20T00:00:00.000Z" },
						{ id: "b", kind: "lowScore", detectedAt: "x", acknowledgedAt: "y" },
					],
				},
			},
		});
		const { d } = deps({
			installed: () => [
				installed("gitlab"),
				installed("git"),
				installed("github"),
				{ ...installed("gitlab"), id: "gitlab", command: "node" },
				{ id: 4 },
			],
		});
		expect(installedWatchView({ id: "p1", path: "/projects/p1" }, d)).toEqual({
			lastRun: "2026-11-20T00:00:00.000Z",
			servers: [
				{
					serverId: "gitlab",
					status: "watched",
					alerts: [{ id: "a", kind: "deprecated", detectedAt: "2026-11-20T00:00:00.000Z" }],
					checkedAt: BASE.checkedAt,
				},
				{ serverId: "git", status: "pending", alerts: [] },
				{ serverId: "github", status: "remote", alerts: [] },
				{ serverId: "gitlab", status: "unverifiable", alerts: [] },
			],
		});
		const offline = installedWatchView({ id: "p2", path: "/projects/air" }, deps({ installed: () => [installed("git")] }).d);
		expect(offline).toEqual({
			lastRun: "2026-11-20T00:00:00.000Z",
			servers: [{ serverId: "git", status: "offline", alerts: [] }],
		});
	});

	it("has no last run before the first check", () => {
		const { d } = deps({ installed: () => [] });
		expect(installedWatchView({ id: "p1", path: "/projects/p1" }, d)).toEqual({ servers: [] });
	});
});

describe("requests", () => {
	it("checks the project id and the server id the renderer sends", () => {
		expect(parseWatchRequest({ projectId: "p1" })).toEqual({ projectId: "p1" });
		for (const bad of [null, "p1", {}, { projectId: "" }, { projectId: 3 }]) {
			expect(() => parseWatchRequest(bad)).toThrow(McpWatchRequestError);
		}
		expect(parseAcknowledgeRequest({ serverId: "gitlab" })).toEqual({ serverId: "gitlab" });
		for (const bad of [undefined, { serverId: "../x" }, { serverId: "" }, { serverId: ["a"] }]) {
			expect(() => parseAcknowledgeRequest(bad)).toThrow(McpWatchRequestError);
		}
	});
});
