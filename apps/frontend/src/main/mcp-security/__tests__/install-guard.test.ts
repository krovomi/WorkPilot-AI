/**
 * The install policy where the project's settings are written: only what is
 * added or changed is checked, removing always passes, a catalog id with a
 * launcher of its own is a server outside the catalog, and the score is the
 * main's.
 */
import { describe, expect, it, vi } from "vitest";
import { buildCatalogServer, loadMcpCatalog } from "../../../shared/mcp-catalog/install";
import { invalidPolicy } from "../../../shared/mcp-catalog/install-policy";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import type { McpPolicyState } from "../../../shared/types/mcp-policy";
import { type InstallGuardDeps, mcpInstallRefusal, refusalMessage } from "../install-guard";

const catalog = loadMcpCatalog();
const entry = (id: string) => catalog.find((s) => s.id === id) as McpMarketplaceServer;
const server = (id: string) => {
	const e = entry(id);
	const built = buildCatalogServer(e, Object.fromEntries(e.vars.map((v) => [v.name, "x"])));
	if (!built.ok) throw new Error(id);
	return built.server;
};
const custom = { id: "mine", name: "Mine", type: "command", command: "node", args: ["s.js"] };

function deps(policy: McpPolicyState, score = 80): InstallGuardDeps & { score: ReturnType<typeof vi.fn> } {
	return {
		readPolicy: vi.fn(() => policy),
		catalog: () => catalog,
		score: vi.fn(async () => score),
	};
}
const active = (policy: Partial<{ allowedServers: string[]; minScore: number; blockCustomServers: boolean }>) =>
	({ state: "active", policy: { blockCustomServers: false, ...policy } }) as McpPolicyState;

describe("mcpInstallRefusal", () => {
	it("checks nothing when the servers are not part of the update", async () => {
		const d = deps(invalidPolicy("notJson"));
		expect(await mcpInstallRefusal("/p", [], undefined, d)).toBeNull();
		expect(d.readPolicy).not.toHaveBeenCalled();
	});

	it("lets kept and removed servers through, whatever the policy", async () => {
		const d = deps(invalidPolicy("notJson"));
		const kept = { ...server("gitlab") };
		const reordered = Object.fromEntries(Object.entries(kept).reverse());
		expect(await mcpInstallRefusal("/p", [kept, custom], [reordered], d)).toBeNull();
		expect(await mcpInstallRefusal("/p", [kept], [], d)).toBeNull();
		expect(d.readPolicy).not.toHaveBeenCalled();
	});

	it("lets anything through without a policy", async () => {
		expect(await mcpInstallRefusal("/p", [], [custom], deps({ state: "none" }))).toBeNull();
	});

	it("refuses anything new under an invalid policy", async () => {
		const refusal = await mcpInstallRefusal("/p", [], [server("gitlab")], deps(invalidPolicy("schema")));
		expect(refusal).toEqual({ reason: "policyInvalid", serverId: "gitlab", name: "GitLab" });
	});

	it("refuses a server outside the catalog, and a catalog id with a launcher of its own", async () => {
		const d = deps(active({ blockCustomServers: true }));
		expect((await mcpInstallRefusal("/p", [], [custom], d))?.reason).toBe("customBlocked");
		const forged = { ...server("gitlab"), args: ["-y", "evil"] };
		expect(await mcpInstallRefusal("/p", [], [forged], d)).toEqual({
			reason: "customBlocked",
			serverId: "gitlab",
			name: "GitLab",
		});
		expect(await mcpInstallRefusal("/p", [], [server("gitlab")], d)).toBeNull();
	});

	it("names a server sent without a usable id or name as it can", async () => {
		const d = deps(active({ blockCustomServers: true }));
		expect((await mcpInstallRefusal("/p", [], [undefined], d))?.serverId).toBe("");
		expect(await mcpInstallRefusal("/p", [], ["junk"], d)).toEqual({
			reason: "customBlocked",
			serverId: "",
			name: "",
		});
		expect(await mcpInstallRefusal("/p", [], { id: "solo" }, d)).toEqual({
			reason: "customBlocked",
			serverId: "solo",
			name: "solo",
		});
	});

	it("refuses a catalog server the list leaves out, and a changed one", async () => {
		const d = deps(active({ allowedServers: ["gitlab"] }));
		expect(await mcpInstallRefusal("/p", [], [server("gitlab")], d)).toBeNull();
		expect((await mcpInstallRefusal("/p", [], [server("git")], d))?.reason).toBe("notAllowed");
		const stored = server("git");
		const changed = { ...stored, name: "Renamed" };
		expect(await mcpInstallRefusal("/p", [stored], [changed], d)).toEqual({
			reason: "notAllowed",
			serverId: "git",
			name: "Renamed",
		});
	});

	it("asks the main's score only when the policy has a minimum", async () => {
		const without = deps(active({}));
		expect(await mcpInstallRefusal("/p", [], [server("gitlab")], without)).toBeNull();
		expect(without.score).not.toHaveBeenCalled();

		const low = deps(active({ minScore: 70 }), 55);
		expect(await mcpInstallRefusal("/proj", [], [custom, server("gitlab")], low)).toEqual({
			reason: "scoreTooLow",
			serverId: "gitlab",
			name: "GitLab",
			score: 55,
			minScore: 70,
		});
		expect(low.score).toHaveBeenCalledTimes(1);
		expect(low.score).toHaveBeenCalledWith(entry("gitlab"), "/proj");
	});
});

describe("refusalMessage", () => {
	it("says each refusal in English for a caller that shows the error as is", () => {
		const base = { serverId: "git", name: "Git" };
		expect(refusalMessage({ reason: "policyInvalid", ...base })).toMatch(/invalid/);
		expect(refusalMessage({ reason: "notAllowed", ...base })).toMatch(/does not allow Git/);
		expect(refusalMessage({ reason: "scoreTooLow", ...base, score: 40, minScore: 60 })).toMatch(
			/60 or more; Git has 40/,
		);
		expect(refusalMessage({ reason: "customBlocked", serverId: "x", name: "" })).toMatch(/\(x\)/);
	});
});
