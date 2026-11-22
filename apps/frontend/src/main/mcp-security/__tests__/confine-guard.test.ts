/**
 * A low-score server is written confined (#369, lot 5): under `confineBelow`
 * every command server of the list, kept ones included, that has no
 * `confine` of its own gets one when it is outside the catalog or scores
 * under the threshold; nothing changes without the field.
 */
import { describe, expect, it, vi } from "vitest";
import { buildCatalogServer, loadMcpCatalog } from "../../../shared/mcp-catalog/install";
import { invalidPolicy } from "../../../shared/mcp-catalog/install-policy";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type { McpPolicyState } from "../../../shared/types/mcp-policy";
import { withMcpConfinement } from "../confine-guard";
import type { InstallGuardDeps } from "../install-guard";

const catalog = loadMcpCatalog();
const stdio = catalog.find((s) => s.transport === "stdio") as McpMarketplaceServer;
const built = buildCatalogServer(stdio, Object.fromEntries(stdio.vars.map((v) => [v.name, "x"])));
if (!built.ok) throw new Error(stdio.id);
const CATALOG_SERVER = built.server;
const MINE = { id: "mine", name: "Mine", type: "command", command: "node", args: ["s.js"] };

function deps(policy: McpPolicyState, score = 80): InstallGuardDeps {
	return { readPolicy: vi.fn(() => policy), catalog: () => catalog, score: vi.fn(async () => score) };
}
const confineBelow = (min: number): McpPolicyState => ({
	state: "active",
	policy: { blockCustomServers: false, confineBelow: min },
});

describe("withMcpConfinement", () => {
	it("leaves an update without servers, or without confineBelow, as it is", async () => {
		const d = deps(confineBelow(50));
		expect(await withMcpConfinement("/p", undefined, d)).toBeUndefined();
		expect(await withMcpConfinement("/p", [], d)).toEqual([]);
		expect(d.readPolicy).not.toHaveBeenCalled();
		const list = [MINE];
		expect(await withMcpConfinement("/p", list, deps({ state: "none" }))).toBe(list);
		expect(await withMcpConfinement("/p", list, deps(invalidPolicy("schema")))).toBe(list);
		const noField: McpPolicyState = { state: "active", policy: { blockCustomServers: false } };
		expect(await withMcpConfinement("/p", list, deps(noField))).toBe(list);
	});

	it("confines a server outside the catalog: it has no score", async () => {
		const d = deps(confineBelow(10));
		expect(await withMcpConfinement("/p", [MINE], d)).toEqual([{ ...MINE, confine: { hosts: [] } }]);
		expect(d.score).not.toHaveBeenCalled();
	});

	it("confines a catalog server under the threshold, with the main's score", async () => {
		const low = deps(confineBelow(60), 45);
		expect(await withMcpConfinement("/p", [CATALOG_SERVER], low)).toEqual([
			{ ...CATALOG_SERVER, confine: { hosts: [] } },
		]);
		expect(low.score).toHaveBeenCalledWith(stdio, "/p");
		const high = deps(confineBelow(60), 60);
		expect(await withMcpConfinement("/p", [CATALOG_SERVER], high)).toEqual([CATALOG_SERVER]);
	});

	it("keeps a confine already written, and never confines an HTTP server or a non-server", async () => {
		const own = { ...MINE, confine: { hosts: ["api.example.com"] } };
		const remote = { id: "r", name: "R", type: "http", url: "https://mcp.example.com/mcp" };
		const d = deps(confineBelow(100));
		expect(await withMcpConfinement("/p", [own, remote, "junk", null], d)).toEqual([
			own,
			remote,
			"junk",
			null,
		]);
	});
});
