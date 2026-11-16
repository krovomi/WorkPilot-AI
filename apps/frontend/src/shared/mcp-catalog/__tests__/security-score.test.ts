import { describe, expect, it } from "vitest";
import type { McpMarketplaceServer } from "../../types/mcp-marketplace";
import type { McpRegistryFacts } from "../../types/mcp-security";
import { loadMcpCatalog } from "../install";
import {
	ABANDONED_DAYS,
	isPinned,
	scoreServer,
	securityLevel,
	toolPower,
} from "../security-score";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const DAY = 86_400_000;

function server(over: Partial<McpMarketplaceServer> = {}): McpMarketplaceServer {
	return {
		id: "demo",
		name: "Demo",
		tagline: { en: "Demo", fr: "Démo" },
		description: { en: "Demo", fr: "Démo" },
		author: "Demo Inc",
		official: true,
		category: "development",
		color: "#000000",
		package: "demo-mcp",
		transport: "stdio",
		command: "npx",
		args: ["-y", "demo-mcp@1.2.3"],
		vars: [],
		tools: [{ name: "list_items", description: "" }],
		tags: [],
		homepage: "https://example.com",
		...over,
	} as McpMarketplaceServer;
}

function facts(over: Partial<McpRegistryFacts> = {}): McpRegistryFacts {
	return {
		ecosystem: "npm",
		version: "1.2.3",
		lastRelease: new Date(NOW - 10 * DAY).toISOString(),
		maintainers: ["alice"],
		firstSeenMaintainers: ["alice"],
		repository: "https://github.com/demo/demo",
		vulnerabilities: [],
		checkedAt: new Date(NOW).toISOString(),
		...over,
	};
}

const dim = (score: ReturnType<typeof scoreServer>, key: string) =>
	score.dimensions.find((d) => d.key === key);

describe("toolPower", () => {
	it("tells commands, writes and reads apart from the tool name", () => {
		expect(toolPower("run_command")).toBe("exec");
		expect(toolPower("kubectl-apply")).toBe("exec");
		expect(toolPower("create_issue")).toBe("write");
		expect(toolPower("browser_click")).toBe("write");
		expect(toolPower("list_issues")).toBe("read");
		expect(toolPower("search")).toBe("read");
	});
});

describe("isPinned", () => {
	it("needs an exact version after the package name", () => {
		expect(isPinned(server())).toBe(true);
		expect(isPinned(server({ args: ["demo-mcp==1.2"] }))).toBe(true);
		expect(isPinned(server({ args: ["-y", "demo-mcp"] }))).toBe(false);
		expect(isPinned(server({ args: ["demo-mcp@latest"] }))).toBe(false);
		expect(isPinned(server({ args: ["demo-mcp-extra"] }))).toBe(false);
		expect(isPinned(server({ args: undefined }))).toBe(false);
	});
});

describe("securityLevel", () => {
	it("cuts at 75 and 50", () => {
		expect(securityLevel(75)).toBe("high");
		expect(securityLevel(74)).toBe("medium");
		expect(securityLevel(50)).toBe("medium");
		expect(securityLevel(49)).toBe("low");
	});
});

describe("scoreServer", () => {
	it("gives an official, pinned, read-only and clean package a high score", () => {
		const score = scoreServer(server(), { facts: facts(), now: NOW });
		expect(score.dimensions).toHaveLength(6);
		expect(score.level).toBe("high");
		expect(score.checked).toBe(true);
		expect(score.checkedAt).toBe(new Date(NOW).toISOString());
		expect(score.alerts).toEqual([]);
		expect(dim(score, "supplyChain")?.values).toEqual({ version: "1.2.3" });
		expect(dim(score, "maintainers")?.values).toEqual({ count: 1 });
		expect(score.unchecked).toBeUndefined();
	});

	it("counts half of the registry dimensions before the registry is read", () => {
		const score = scoreServer(server({ official: false, args: ["demo-mcp"] }));
		expect(score.checked).toBe(false);
		expect(score.checkedAt).toBeUndefined();
		for (const key of ["freshness", "supplyChain", "maintainers"]) {
			expect(dim(score, key)?.status).toBe("unknown");
		}
		expect(dim(score, "publisher")?.reason).toBe("community");
		expect(dim(score, "execution")?.reason).toBe("localUnpinned");
		expect(score.alerts).toEqual([{ kind: "unpinned" }]);
	});

	it("scores a remote server out of its three dimensions", () => {
		const score = scoreServer(
			server({ transport: "http", command: undefined, args: undefined, url: "https://x" }),
			{ facts: facts(), unchecked: "offline" },
		);
		expect(score.dimensions.map((d) => d.key)).toEqual([
			"publisher",
			"permissions",
			"execution",
		]);
		expect(score.score).toBe(100);
		expect(score.unchecked).toBe("remote");
	});

	it("keeps why the registry was not read", () => {
		expect(scoreServer(server(), { unchecked: "unreachable" }).unchecked).toBe("unreachable");
	});

	it("flags tools that run commands, unless a read-only flag is passed", () => {
		const exec = server({
			tools: [
				{ name: "execute_command", description: "" },
				{ name: "list_files", description: "" },
			],
		});
		const score = scoreServer(exec, { facts: facts(), now: NOW });
		expect(dim(score, "permissions")).toMatchObject({ status: "risk", points: 5 });
		expect(score.alerts).toContainEqual({
			kind: "executesCommands",
			values: { tools: "execute_command" },
		});
		const restricted = scoreServer(
			{ ...exec, args: ["demo-mcp@1.2.3", "--read-only"] },
			{ facts: facts(), now: NOW },
		);
		expect(dim(restricted, "permissions")).toMatchObject({ reason: "readOnlyFlag", points: 17 });
	});

	it("marks a server whose tools write", () => {
		const score = scoreServer(server({ tools: [{ name: "create_page", description: "" }] }));
		expect(dim(score, "permissions")).toMatchObject({ reason: "writes", status: "warn" });
	});

	it("warns of an abandoned package and of a deprecated one", () => {
		const stale = scoreServer(server(), {
			facts: facts({ lastRelease: new Date(NOW - (ABANDONED_DAYS + 10) * DAY).toISOString() }),
			now: NOW,
		});
		expect(dim(stale, "freshness")).toMatchObject({ reason: "stale", points: 4 });
		expect(stale.alerts).toContainEqual({
			kind: "abandoned",
			values: { days: ABANDONED_DAYS + 10 },
		});
		const deprecated = scoreServer(server(), {
			facts: facts({ deprecated: true }),
			now: NOW,
		});
		expect(dim(deprecated, "freshness")).toMatchObject({ reason: "deprecated", points: 0 });
		expect(deprecated.alerts).toContainEqual({ kind: "deprecated" });
	});

	it("treats a release date it cannot read as unknown", () => {
		const score = scoreServer(server(), { facts: facts({ lastRelease: undefined }), now: NOW });
		expect(dim(score, "freshness")?.status).toBe("unknown");
		const bad = scoreServer(server(), { facts: facts({ lastRelease: "not a date" }), now: NOW });
		expect(dim(bad, "freshness")?.status).toBe("unknown");
	});

	it("counts no days for a release dated in the future", () => {
		const score = scoreServer(server(), {
			facts: facts({ lastRelease: new Date(NOW + DAY).toISOString() }),
			now: NOW,
		});
		expect(dim(score, "freshness")?.values).toEqual({ days: 0 });
	});

	it("lists each known vulnerability and sinks the supply chain", () => {
		const score = scoreServer(server(), {
			facts: facts({
				vulnerabilities: [
					{ id: "GHSA-1", summary: "one" },
					{ id: "GHSA-2", summary: "two" },
				],
			}),
			now: NOW,
		});
		expect(dim(score, "supplyChain")).toMatchObject({ points: 0, values: { count: 2 } });
		expect(score.alerts.filter((a) => a.kind === "vulnerability")).toHaveLength(2);
	});

	it("does not claim a clean supply chain when OSV could not be read", () => {
		const score = scoreServer(server(), {
			facts: facts({ vulnerabilitiesUnknown: true }),
			now: NOW,
		});
		expect(dim(score, "supplyChain")?.status).toBe("unknown");
	});

	it("names the version as empty when the registry gave none", () => {
		const score = scoreServer(server(), { facts: facts({ version: undefined }), now: NOW });
		expect(dim(score, "supplyChain")?.values).toEqual({ version: "" });
	});

	it("raises a maintainer change, and a package without a source", () => {
		const changed = scoreServer(server(), {
			facts: facts({ maintainers: ["alice", "mallory"] }),
			now: NOW,
		});
		expect(dim(changed, "maintainers")).toMatchObject({ status: "risk", points: 0 });
		expect(changed.alerts).toContainEqual({
			kind: "maintainerChanged",
			values: { names: "mallory" },
		});
		const noSource = scoreServer(server(), {
			facts: facts({ repository: undefined }),
			now: NOW,
		});
		expect(dim(noSource, "maintainers")?.reason).toBe("noSource");
		expect(noSource.alerts).toContainEqual({ kind: "noSource" });
	});

	it("does not call a change when no maintainer was seen at first", () => {
		const score = scoreServer(server(), {
			facts: facts({ firstSeenMaintainers: [], maintainers: ["bob"] }),
			now: NOW,
		});
		expect(dim(score, "maintainers")?.reason).toBe("stable");
	});

	it("scores every catalog server between 0 and 100", () => {
		for (const entry of loadMcpCatalog()) {
			const score = scoreServer(entry);
			expect(score.score).toBeGreaterThanOrEqual(0);
			expect(score.score).toBeLessThanOrEqual(100);
			expect(score.serverId).toBe(entry.id);
		}
	});
});
