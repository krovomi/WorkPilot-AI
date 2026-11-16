import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import { CACHE_TTL_MS, type Fetcher, packageOf, RegistryFactsStore } from "../registry-facts";

const NOW = Date.parse("2026-11-15T12:00:00Z");

function entry(over: Partial<McpMarketplaceServer> = {}): McpMarketplaceServer {
	return {
		id: "demo",
		package: "@demo/mcp",
		transport: "stdio",
		command: "npx",
		args: ["-y", "@demo/mcp@1.2.3"],
		...over,
	} as McpMarketplaceServer;
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

const npmDoc = (maintainers: unknown[] = [{ name: "alice" }]) => ({
	"dist-tags": { latest: "1.3.0" },
	time: { "1.3.0": "2026-11-01T00:00:00Z" },
	maintainers,
	repository: { url: "git+https://github.com/demo/mcp.git" },
	versions: {
		"1.2.3": { deprecated: "use 1.3" },
		"1.3.0": { repository: "https://github.com/demo/mcp" },
	},
});

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-facts-"));
	file = path.join(dir, "nested", "facts.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A fetcher that answers by host, and records each call. */
function fetcher(answers: Record<string, () => Response | Promise<Response>>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fn: Fetcher = async (url, init) => {
		calls.push({ url, init });
		const host = new URL(url).host;
		const answer = answers[host];
		if (!answer) throw new Error(`unexpected ${url}`);
		return answer();
	};
	return { fn, calls };
}

describe("packageOf", () => {
	it("reads the npm package and its pinned version", () => {
		expect(packageOf(entry())).toEqual({ ecosystem: "npm", name: "@demo/mcp", version: "1.2.3" });
		expect(packageOf(entry({ args: ["-y", "@demo/mcp"] }))).toEqual({
			ecosystem: "npm",
			name: "@demo/mcp",
		});
		expect(packageOf(entry({ args: undefined }))).toEqual({ ecosystem: "npm", name: "@demo/mcp" });
	});

	it("reads a PyPI package started by uvx", () => {
		expect(
			packageOf(entry({ command: "uvx", package: "demo-mcp", args: ["demo-mcp==0.4.1"] })),
		).toEqual({ ecosystem: "PyPI", name: "demo-mcp", version: "0.4.1" });
	});

	it("refuses a remote server, another launcher, or a name that is not a package", () => {
		expect(packageOf(entry({ transport: "http" }))).toBeNull();
		expect(packageOf(entry({ command: "docker" }))).toBeNull();
		expect(packageOf(entry({ package: "../../etc/passwd" }))).toBeNull();
		expect(packageOf(entry({ command: "uvx", package: "bad/name" }))).toBeNull();
	});
});

describe("RegistryFactsStore", () => {
	it("reads npm and OSV, and caches the result a day", async () => {
		const { fn, calls } = fetcher({
			"registry.npmjs.org": () => json(npmDoc()),
			"api.osv.dev": () => json({ vulns: [{ id: "GHSA-x", summary: "  bad\n thing " }] }),
		});
		let now = NOW;
		const store = new RegistryFactsStore(file, fn, () => now);
		const facts = await store.facts("demo", { ecosystem: "npm", name: "@demo/mcp", version: "1.2.3" });
		expect(calls[0].url).toBe("https://registry.npmjs.org/@demo%2Fmcp");
		expect(calls[0].init?.redirect).toBe("error");
		expect(JSON.parse(String(calls[1].init?.body))).toEqual({
			package: { name: "@demo/mcp", ecosystem: "npm" },
			version: "1.2.3",
		});
		expect(facts).toMatchObject({
			ecosystem: "npm",
			version: "1.2.3",
			lastRelease: "2026-11-01T00:00:00Z",
			maintainers: ["alice"],
			firstSeenMaintainers: ["alice"],
			repository: "git+https://github.com/demo/mcp.git",
			deprecated: true,
			vulnerabilities: [{ id: "GHSA-x", summary: "bad thing" }],
			checkedAt: new Date(NOW).toISOString(),
		});
		expect(facts.vulnerabilitiesUnknown).toBeUndefined();
		expect(store.cached("demo")).toEqual(facts);

		now = NOW + CACHE_TTL_MS - 1;
		await store.facts("demo", { ecosystem: "npm", name: "@demo/mcp" });
		expect(calls).toHaveLength(2);

		await store.facts("demo", { ecosystem: "npm", name: "@demo/mcp" }, true);
		expect(calls).toHaveLength(4);
	});

	it("keeps the first maintainers seen, so a takeover shows", async () => {
		let maintainers: unknown[] = [{ name: "alice" }];
		const { fn } = fetcher({
			"registry.npmjs.org": () => json(npmDoc(maintainers)),
			"api.osv.dev": () => json({}),
		});
		let now = NOW;
		const store = new RegistryFactsStore(file, fn, () => now);
		await store.facts("demo", { ecosystem: "npm", name: "@demo/mcp" });
		maintainers = ["mallory", { name: "alice" }, 42];
		now += CACHE_TTL_MS + 1;
		const facts = await store.facts("demo", { ecosystem: "npm", name: "@demo/mcp" });
		expect(facts.maintainers).toEqual(["alice", "mallory"]);
		expect(facts.firstSeenMaintainers).toEqual(["alice"]);
		expect(facts.version).toBe("1.3.0");
		expect(facts.repository).toBe("https://github.com/demo/mcp");
		expect(facts.deprecated).toBe(false);
	});

	it("reads a document without the expected fields as empty facts", async () => {
		const { fn } = fetcher({
			"registry.npmjs.org": () => json([]),
			"api.osv.dev": () => json({ vulns: "nope" }),
		});
		const store = new RegistryFactsStore(file, fn, () => NOW);
		const facts = await store.facts("demo", { ecosystem: "npm", name: "demo" });
		expect(facts).toMatchObject({
			version: "",
			maintainers: [],
			vulnerabilities: [],
		});
		expect(facts.lastRelease).toBeUndefined();
		expect(facts.repository).toBeUndefined();
	});

	it("reads PyPI, pinned or not", async () => {
		const pypi = {
			info: {
				version: "0.4.1",
				maintainer: "bob",
				author: "bob",
				project_urls: { Docs: "https://docs.example", Source: "https://github.com/demo/py" },
				home_page: null,
				yanked: false,
			},
			urls: [
				{ upload_time_iso_8601: "2026-10-02T00:00:00Z" },
				{ upload_time_iso_8601: "2026-10-03T00:00:00Z" },
				{},
			],
		};
		const { fn, calls } = fetcher({
			"pypi.org": () => json(pypi),
			"api.osv.dev": () => json({ vulns: [] }),
		});
		const store = new RegistryFactsStore(file, fn, () => NOW);
		const facts = await store.facts("py", { ecosystem: "PyPI", name: "demo-mcp", version: "0.4.1" });
		expect(calls[0].url).toBe("https://pypi.org/pypi/demo-mcp/0.4.1/json");
		expect(facts).toMatchObject({
			ecosystem: "PyPI",
			version: "0.4.1",
			lastRelease: "2026-10-03T00:00:00Z",
			maintainers: ["bob"],
			repository: "https://github.com/demo/py",
			deprecated: false,
		});

		await store.facts("py2", { ecosystem: "PyPI", name: "demo-mcp" });
		expect(calls[2].url).toBe("https://pypi.org/pypi/demo-mcp/json");
	});

	it("keeps the pinned version when PyPI gives none", async () => {
		const { fn } = fetcher({
			"pypi.org": () => json({}),
			"api.osv.dev": () => json({}),
		});
		const store = new RegistryFactsStore(file, fn, () => NOW);
		const facts = await store.facts("py", { ecosystem: "PyPI", name: "demo", version: "1.0" });
		expect(facts.version).toBe("1.0");
		expect(facts.maintainers).toEqual([]);
		expect(facts.repository).toBeUndefined();
		expect(facts.lastRelease).toBeUndefined();
	});

	it("says the vulnerabilities are unknown when OSV fails", async () => {
		const { fn } = fetcher({
			"registry.npmjs.org": () => json(npmDoc()),
			"api.osv.dev": () => json({}, { status: 503 }),
		});
		const store = new RegistryFactsStore(file, fn, () => NOW);
		const facts = await store.facts("demo", { ecosystem: "npm", name: "demo" });
		expect(facts.vulnerabilitiesUnknown).toBe(true);
		expect(facts.vulnerabilities).toEqual([]);
	});

	it("throws when the registry fails, and keeps nothing", async () => {
		const { fn } = fetcher({ "registry.npmjs.org": () => json({}, { status: 404 }) });
		const store = new RegistryFactsStore(file, fn, () => NOW);
		await expect(store.facts("demo", { ecosystem: "npm", name: "demo" })).rejects.toThrow(
			"HTTP 404",
		);
		expect(store.cached("demo")).toBeUndefined();
	});

	it("refuses a body over the size limit, declared or read", async () => {
		const declared = fetcher({
			"registry.npmjs.org": () =>
				new Response("{}", { headers: { "content-length": String(16 * 1024 * 1024) } }),
		});
		await expect(
			new RegistryFactsStore(file, declared.fn, () => NOW).facts("demo", {
				ecosystem: "npm",
				name: "demo",
			}),
		).rejects.toThrow("response too large");

		const big = "x".repeat(15 * 1024 * 1024 + 1);
		const read = fetcher({
			"registry.npmjs.org": () => ({
				ok: true,
				status: 200,
				headers: new Headers(),
				text: async () => big,
			}) as unknown as Response,
		});
		await expect(
			new RegistryFactsStore(file, read.fn, () => NOW).facts("demo", {
				ecosystem: "npm",
				name: "demo",
			}),
		).rejects.toThrow("response too large");
	});

	it("starts afresh from a cache file it cannot read", async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{ not json");
		const store = new RegistryFactsStore(file, vi.fn() as unknown as Fetcher, () => NOW);
		expect(store.cached("demo")).toBeUndefined();
	});
});
