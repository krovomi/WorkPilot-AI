/**
 * A custom server is the catalog server it names only when it is that server
 * as the catalog defines it: what the marketplace installs always is, and a
 * server with a command, an argument, a URL, a header or an environment of
 * its own never is (#369, lot 2).
 */
import { describe, expect, it } from "vitest";
import type { McpMarketplaceServer } from "../../types/mcp-marketplace";
import { matchCatalogServer } from "../catalog-match";
import { buildCatalogServer, loadMcpCatalog } from "../install";

const catalog = loadMcpCatalog();
const byId = (id: string) => catalog.find((s) => s.id === id) as McpMarketplaceServer;

const filled = (entry: McpMarketplaceServer, onlyRequired = false) =>
	Object.fromEntries(
		entry.vars.filter((v) => !onlyRequired || v.required).map((v) => [v.name, `value-${v.name}`]),
	);

function built(id: string, values?: Record<string, string>) {
	const entry = byId(id);
	const result = buildCatalogServer(entry, values ?? filled(entry));
	if (!result.ok) throw new Error(`cannot build ${id}`);
	return result.server;
}

describe("matchCatalogServer", () => {
	it("recognises every catalog server the marketplace installs", () => {
		for (const entry of catalog) {
			for (const values of [filled(entry), filled(entry, true)]) {
				const result = buildCatalogServer(entry, values);
				if (!result.ok) continue;
				expect(matchCatalogServer(result.server, catalog)?.id).toBe(entry.id);
			}
		}
	});

	it("is not a catalog server: not an object, no id, an unknown id", () => {
		for (const value of [null, "gitlab", [], { name: "x" }, { id: 3 }, { id: "nope" }]) {
			expect(matchCatalogServer(value, catalog)).toBeNull();
		}
	});

	it("refuses a catalog id with a launcher or arguments of its own", () => {
		const gitlab = built("gitlab");
		expect(matchCatalogServer({ ...gitlab, command: "node" }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...gitlab, type: "http" }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...gitlab, args: ["-y", "evil-pkg"] }, catalog)).toBeNull();
		expect(
			matchCatalogServer({ ...gitlab, args: [...(gitlab.args ?? []), "--extra"] }, catalog),
		).toBeNull();
		expect(matchCatalogServer({ ...gitlab, args: ["-y"] }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...gitlab, args: "-y" }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...gitlab, args: [1] }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...gitlab, args: undefined }, catalog)).toBeNull();
	});

	it("takes the launcher's default when the catalog names none", () => {
		const entry = { ...byId("gitlab"), id: "nocmd", command: undefined } as McpMarketplaceServer;
		const server = { id: "nocmd", type: "command", command: "npx", args: entry.args };
		expect(matchCatalogServer(server, [entry])?.id).toBe("nocmd");
		const bare = { ...entry, args: undefined } as McpMarketplaceServer;
		expect(matchCatalogServer({ id: "nocmd", type: "command", command: "npx" }, [bare])?.id).toBe("nocmd");
	});

	it("fills a placeholder argument with any non-empty value, in place", () => {
		const ado = built("azure-devops");
		expect(matchCatalogServer(ado, catalog)?.id).toBe("azure-devops");
		expect(
			matchCatalogServer({ ...ado, args: ["-y", "@azure-devops/mcp", "--authentication", "azcli"] }, catalog),
		).toBeNull();
		const supabase = built("supabase", { SUPABASE_ACCESS_TOKEN: "t" });
		expect(supabase.args).not.toContain("--project-ref=");
		expect(matchCatalogServer(supabase, catalog)?.id).toBe("supabase");
		expect(
			matchCatalogServer({ ...supabase, args: [...(supabase.args ?? []), "--project-ref="] }, catalog),
		).toBeNull();
		expect(
			matchCatalogServer(
				{ ...supabase, args: (supabase.args ?? []).filter((a) => a !== "--read-only") },
				catalog,
			),
		).toBeNull();
	});

	it("matches literal pieces around placeholders, without regular expressions", () => {
		const required = (name: string) => ({ name, label: name, required: true });
		const entry = {
			...byId("gitlab"),
			id: "multi",
			args: ["-y", "--x=${B}:${C}.end", "${D}${E}"],
			vars: [required("D"), required("E")],
			env: undefined,
		} as unknown as McpMarketplaceServer;
		const server = (args: string[]) => ({ id: "multi", type: "command", command: "npx", args });
		expect(matchCatalogServer(server(["-y", "--x=b:c.end", "de"]), [entry])).not.toBeNull();
		expect(matchCatalogServer(server(["-y", "de"]), [entry])).not.toBeNull();
		for (const bad of [
			["-y", "--x=:c.end", "de"],
			["-y", "--x=b:.end", "de"],
			["-y", "--x=b-c.end", "de"],
			["-y", "--x=b:c.ending", "de"],
			["-y", "--y=b:c.end", "de"],
			["-y", "--x=b:c.end", "d"],
			["-y", "d"],
			["-y"],
		]) {
			expect(matchCatalogServer(server(bad), [entry])).toBeNull();
		}
		const long = `--x=${"b:".repeat(50_000)}c.end`;
		expect(matchCatalogServer(server(["-y", long, "de"]), [entry])).not.toBeNull();
	});

	it("keeps the catalog's fixed environment and only adds typed values", () => {
		const k8s = built("kubernetes");
		expect(matchCatalogServer(k8s, catalog)?.id).toBe("kubernetes");
		expect(matchCatalogServer({ ...k8s, env: {} }, catalog)).toBeNull();
		expect(
			matchCatalogServer({ ...k8s, env: { ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS: "false" } }, catalog),
		).toBeNull();
		expect(
			matchCatalogServer({ ...k8s, env: { ...k8s.env, NODE_OPTIONS: "--require x" } }, catalog),
		).toBeNull();
		expect(matchCatalogServer({ ...k8s, env: "x" }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...k8s, env: { A: 1 } }, catalog)).toBeNull();

		const gitlab = built("gitlab");
		expect(gitlab.env?.GITLAB_PERSONAL_ACCESS_TOKEN).toBeDefined();
		expect(matchCatalogServer(gitlab, catalog)?.id).toBe("gitlab");
		const typedOverFixed = {
			...byId("kubernetes"),
			id: "typed",
			vars: [{ name: "ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS", label: "x", required: false }],
		} as McpMarketplaceServer;
		const server = { ...k8s, id: "typed", env: { ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS: "no" } };
		expect(matchCatalogServer(server, [typedOverFixed])?.id).toBe("typed");
	});

	it("checks a remote server's URL and headers", () => {
		const github = built("github");
		expect(matchCatalogServer(github, catalog)?.id).toBe("github");
		expect(matchCatalogServer({ ...github, type: "command" }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...github, url: "https://evil.example/mcp/" }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...github, url: 3 }, catalog)).toBeNull();
		expect(
			matchCatalogServer({ ...github, headers: { ...github.headers, "X-Extra": "1" } }, catalog),
		).toBeNull();
		expect(matchCatalogServer({ ...github, headers: { Authorization: "Basic x" } }, catalog)).toBeNull();
		expect(matchCatalogServer({ ...github, headers: [] }, catalog)).toBeNull();
		// The token is required: a header without it is not what the marketplace writes.
		expect(matchCatalogServer({ ...github, headers: undefined }, catalog)).toBeNull();

		const fixedHeader = {
			...byId("github"),
			id: "fixed",
			url: "https://mcp.example/${TENANT}",
			headers: { "X-Client": "workpilot" },
		} as McpMarketplaceServer;
		const remote = { id: "fixed", type: "http", url: "https://mcp.example/acme" };
		expect(matchCatalogServer(remote, [fixedHeader])).toBeNull();
		expect(
			matchCatalogServer({ ...remote, headers: { "X-Client": "workpilot" } }, [fixedHeader])?.id,
		).toBe("fixed");
		const noUrl = { ...fixedHeader, url: undefined, headers: undefined } as McpMarketplaceServer;
		expect(matchCatalogServer({ id: "fixed", type: "http", url: "" }, [noUrl])?.id).toBe("fixed");
	});
});
