import { describe, expect, it, vi } from "vitest";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type { McpRegistryFacts } from "../../../shared/types/mcp-security";
import type { RegistryFactsStore } from "../registry-facts";
import { McpSecurityRequestError, serverSecurity } from "../server-security";

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

const CATALOG = [
	{
		id: "local",
		official: true,
		author: "Demo",
		package: "demo-mcp",
		transport: "stdio",
		command: "npx",
		args: ["demo-mcp@1.0.0"],
		tools: [],
	},
	{
		id: "remote",
		official: true,
		author: "Demo",
		package: "https://mcp.example",
		transport: "http",
		tools: [],
	},
] as unknown as McpMarketplaceServer[];

function deps(over: { facts?: () => Promise<McpRegistryFacts>; offline?: boolean } = {}) {
	const store = {
		facts: vi.fn(over.facts ?? (async () => FACTS)),
		cached: vi.fn(() => FACTS),
	};
	return {
		store,
		deps: {
			store: store as unknown as RegistryFactsStore,
			projectPath: (id: string) => (id === "p1" ? "/projects/p1" : undefined),
			offline: vi.fn(() => over.offline ?? false),
			catalog: () => CATALOG,
		},
	};
}

describe("serverSecurity", () => {
	it("refuses a request without a catalog server id", async () => {
		const { deps: d } = deps();
		for (const raw of [null, "local", {}, { serverId: "" }, { serverId: 3 }]) {
			await expect(serverSecurity(raw, d)).rejects.toBeInstanceOf(McpSecurityRequestError);
		}
		await expect(serverSecurity({ serverId: "local", projectId: 7 }, d)).rejects.toThrow(
			"Invalid project id",
		);
		await expect(serverSecurity({ serverId: "nope" }, d)).rejects.toThrow(
			"Unknown catalog server",
		);
	});

	it("reads the registry for a local package", async () => {
		const { deps: d, store } = deps();
		const score = await serverSecurity({ serverId: "local", refresh: true }, d);
		expect(store.facts).toHaveBeenCalledWith(
			"local",
			{ ecosystem: "npm", name: "demo-mcp", version: "1.0.0" },
			true,
		);
		expect(score.checked).toBe(true);
		expect(d.offline).not.toHaveBeenCalled();
	});

	it("only takes refresh when it is true", async () => {
		const { deps: d, store } = deps();
		await serverSecurity({ serverId: "local", refresh: "yes", projectId: null }, d);
		expect(store.facts).toHaveBeenCalledWith("local", expect.anything(), false);
	});

	it("scores a remote server from the catalog alone", async () => {
		const { deps: d, store } = deps();
		const score = await serverSecurity({ serverId: "remote" }, d);
		expect(score.unchecked).toBe("remote");
		expect(store.facts).not.toHaveBeenCalled();
	});

	it("makes no network call for a project in strict offline mode", async () => {
		const { deps: d, store } = deps({ offline: true });
		const score = await serverSecurity({ serverId: "local", projectId: "p1" }, d);
		expect(d.offline).toHaveBeenCalledWith("/projects/p1");
		expect(store.facts).not.toHaveBeenCalled();
		expect(score.unchecked).toBe("offline");
		expect(score.checked).toBe(true);
	});

	it("ignores a project id that is not registered", async () => {
		const { deps: d, store } = deps({ offline: true });
		await serverSecurity({ serverId: "local", projectId: "unknown" }, d);
		expect(d.offline).not.toHaveBeenCalled();
		expect(store.facts).toHaveBeenCalled();
	});

	it("falls back on the last facts when the registry is unreachable", async () => {
		const { deps: d } = deps({
			facts: async () => {
				throw new Error("offline");
			},
		});
		const score = await serverSecurity({ serverId: "local", projectId: "p1" }, d);
		expect(score.unchecked).toBe("unreachable");
		expect(score.checked).toBe(true);
	});

	it("uses the shipped catalog by default", async () => {
		const { deps: d } = deps();
		const { catalog: _catalog, ...rest } = d;
		await expect(serverSecurity({ serverId: "no-such-server" }, rest)).rejects.toThrow(
			"Unknown catalog server",
		);
	});
});
