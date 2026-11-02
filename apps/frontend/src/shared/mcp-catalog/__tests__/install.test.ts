import { describe, expect, it } from "vitest";
import type { McpMarketplaceServer } from "../../types/mcp-marketplace";
import {
	agentsUsingServer,
	buildCatalogServer,
	loadMcpCatalog,
	localized,
	missingCatalogVars,
	placeholderVars,
	withoutServer,
	withServerForAgents,
} from "../install";

const catalog = loadMcpCatalog();
const byId = (id: string): McpMarketplaceServer => {
	const entry = catalog.find((s) => s.id === id);
	if (!entry) throw new Error(`no ${id}`);
	return entry;
};

/** A dummy value for every variable of `entry`. */
const filled = (entry: McpMarketplaceServer): Record<string, string> =>
	Object.fromEntries(entry.vars.map((v) => [v.name, `dummy-${v.name}`]));

describe("MCP catalog data", () => {
	it("offers many servers with unique ids", () => {
		expect(catalog.length).toBeGreaterThanOrEqual(35);
		const ids = catalog.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("drops the packages that do not exist or are deprecated", () => {
		const packages = catalog.map((s) => s.package);
		for (const gone of [
			"@anthropic/mcp-server-jira",
			"@anthropic/mcp-server-notion",
			"@modelcontextprotocol/server-github",
			"@modelcontextprotocol/server-puppeteer",
			"@modelcontextprotocol/server-brave-search",
			"@modelcontextprotocol/server-fetch",
		]) {
			expect(packages).not.toContain(gone);
		}
	});

	it.each(catalog.map((s) => [s.id, s] as const))(
		"%s is complete in both languages",
		(_id, entry) => {
			expect(entry.tagline.en && entry.tagline.fr).toBeTruthy();
			expect(entry.description.en && entry.description.fr).toBeTruthy();
			expect(entry.tools.length).toBeGreaterThan(0);
			expect(entry.homepage).toMatch(/^https:\/\//);
			for (const v of entry.vars) {
				expect(v.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
				expect(v.description.en && v.description.fr).toBeTruthy();
			}
			if (entry.transport === "stdio") {
				expect(["npx", "uvx"]).toContain(entry.command);
			} else {
				expect(entry.url).toMatch(/^https:\/\//);
				// A remote server has no environment: every value must land in
				// the URL or a header, or it would be dropped.
				const referenced = placeholderVars(entry);
				for (const v of entry.vars) expect(referenced).toContain(v.name);
			}
		},
	);

	it.each(catalog.map((s) => [s.id, s] as const))(
		"%s builds a custom server once every value is typed",
		(_id, entry) => {
			const built = buildCatalogServer(entry, filled(entry));
			expect(built.ok).toBe(true);
			if (!built.ok) return;
			const text = JSON.stringify(built.server);
			expect(text).not.toContain("${");
			expect(built.server.id).toBe(entry.id);
		},
	);
});

describe("buildCatalogServer", () => {
	it("puts an unreferenced value in the environment of a stdio server", () => {
		const built = buildCatalogServer(byId("notion"), { NOTION_TOKEN: " ntn_x " });
		expect(built).toEqual({
			ok: true,
			server: expect.objectContaining({
				type: "command",
				command: "npx",
				args: ["-y", "@notionhq/notion-mcp-server"],
				env: { NOTION_TOKEN: "ntn_x" },
			}),
		});
	});

	it("keeps the fixed environment of the catalog entry", () => {
		const built = buildCatalogServer(byId("kubernetes"), {});
		expect(built.ok && built.server.env).toEqual({
			ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS: "true",
		});
	});

	it("fills an arg placeholder and leaves the value out of env", () => {
		const built = buildCatalogServer(byId("azure-devops"), {
			ADO_ORGANIZATION: "contoso",
		});
		expect(built.ok && built.server.args).toEqual([
			"-y",
			"@azure-devops/mcp",
			"contoso",
			"--authentication",
			"azcli",
		]);
		expect(built.ok && built.server.env).toBeUndefined();
	});

	it("drops an arg whose optional value is empty", () => {
		const built = buildCatalogServer(byId("supabase"), {
			SUPABASE_ACCESS_TOKEN: "sbp_x",
		});
		expect(built.ok && built.server.args).toEqual([
			"-y",
			"@supabase/mcp-server-supabase@latest",
			"--read-only",
		]);
	});

	it("fills a bearer header of a remote server", () => {
		const built = buildCatalogServer(byId("github"), {
			GITHUB_PERSONAL_ACCESS_TOKEN: "github_pat_x",
		});
		expect(built).toEqual({
			ok: true,
			server: expect.objectContaining({
				type: "http",
				url: "https://api.githubcopilot.com/mcp/",
				headers: { Authorization: "Bearer github_pat_x" },
			}),
		});
	});

	it("leaves out a header whose optional token is empty", () => {
		const built = buildCatalogServer(byId("huggingface"), {});
		expect(built.ok && built.server.headers).toBeUndefined();
	});

	it("refuses while a required value is empty", () => {
		expect(buildCatalogServer(byId("linear"), { LINEAR_API_KEY: "  " })).toEqual(
			{ ok: false, missing: ["LINEAR_API_KEY"] },
		);
		expect(missingCatalogVars(byId("jira"), { JIRA_URL: "x" })).toEqual([
			"JIRA_USERNAME",
			"JIRA_API_TOKEN",
		]);
	});

	it("describes the server in the UI language", () => {
		const fr = buildCatalogServer(byId("time"), {}, "fr-FR");
		expect(fr.ok && fr.server.description).toBe(byId("time").tagline.fr);
		expect(localized(byId("time").tagline, "en")).toBe(byId("time").tagline.en);
	});
});

describe("agent overrides", () => {
	it("adds a server to agents without duplicating it, and removes it", () => {
		const start = { coder: { add: ["context7"], remove: ["notion"] } };
		const added = withServerForAgents(start, "notion", ["coder", "planner"]);
		expect(added).toEqual({
			coder: { add: ["context7", "notion"], remove: [] },
			planner: { add: ["notion"], remove: [] },
		});
		expect(withServerForAgents(added, "notion", ["coder"]).coder.add).toEqual([
			"context7",
			"notion",
		]);
		expect(agentsUsingServer(added, "notion")).toEqual(["coder", "planner"]);
		const removed = withoutServer(added, "notion");
		expect(agentsUsingServer(removed, "notion")).toEqual([]);
		expect(removed.coder.add).toEqual(["context7"]);
	});
});
