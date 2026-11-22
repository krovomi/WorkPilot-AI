/**
 * @vitest-environment node
 *
 * The services rolled back together (#366, lot 4): the links a person
 * chooses in the app, and the order a rollback goes down them.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEPLOY_LINKS_FILE,
	MAX_LINKS,
	parseDeployLinks,
	readDeployLinks,
	rollbackOrder,
	withLinks,
	writeDeployLinks,
} from "../deploy-links";

describe("parseDeployLinks", () => {
	it("keeps ids only, never a project linked to itself, each once", () => {
		expect(
			parseDeployLinks({
				links: {
					api: ["web", "web", "api", "../x", 3, "worker"],
					"bad id": ["web"],
					web: "api",
					lonely: ["lonely"],
				},
			}),
		).toEqual({ api: ["web", "worker"] });
		expect(parseDeployLinks(null)).toEqual({});
		expect(parseDeployLinks({ links: ["api"] })).toEqual({});
		expect(parseDeployLinks([])).toEqual({});
	});

	it("bounds the links of a project", () => {
		const many = Array.from({ length: 40 }, (_, i) => `p${i}`);
		expect(parseDeployLinks({ links: { api: many } }).api).toHaveLength(MAX_LINKS);
	});
});

describe("links file", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "deploy-links-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("round-trips, and reads nothing from a missing, bad or linked file", () => {
		expect(readDeployLinks(dir)).toEqual({});
		writeDeployLinks(path.join(dir, "nested"), { api: ["web"] });
		expect(readDeployLinks(path.join(dir, "nested"))).toEqual({ api: ["web"] });
		writeFileSync(path.join(dir, DEPLOY_LINKS_FILE), "{oops", "utf-8");
		expect(readDeployLinks(dir)).toEqual({});
		const other = path.join(dir, "other");
		mkdirSync(other);
		symlinkSync(path.join(dir, "nested", DEPLOY_LINKS_FILE), path.join(other, DEPLOY_LINKS_FILE));
		expect(readDeployLinks(other)).toEqual({});
		writeFileSync(path.join(dir, DEPLOY_LINKS_FILE), "x".repeat(600 * 1024), "utf-8");
		expect(readDeployLinks(dir)).toEqual({});
	});
});

describe("withLinks", () => {
	const known = new Set(["api", "web", "worker"]);

	it("keeps known projects other than itself", () => {
		expect(withLinks({ web: ["api"] }, "api", ["web", "web", "gone", "api", "worker"], known)).toEqual({
			web: ["api"],
			api: ["web", "worker"],
		});
		expect(withLinks({ api: ["web"] }, "api", [], known)).toEqual({});
	});

	it("refuses what is not a short list of ids", () => {
		expect(withLinks({}, "api", "web", known)).toBeNull();
		expect(withLinks({}, "api", ["../web"], known)).toBeNull();
		expect(withLinks({}, "api", [1], known)).toBeNull();
		expect(withLinks({}, "api", Array.from({ length: MAX_LINKS + 1 }, () => "web"), known)).toBeNull();
	});
});

describe("rollbackOrder", () => {
	it("goes down the links nearest first, each project once, around a loop", () => {
		const links = { api: ["web", "worker"], worker: ["mail", "api"], web: ["mail"], mail: ["api"] };
		expect(rollbackOrder(links, "api")).toEqual(["web", "worker", "mail"]);
		expect(rollbackOrder(links, "nobody")).toEqual([]);
	});

	it("stops at MAX_LINKS projects", () => {
		const chain: Record<string, string[]> = {};
		for (let i = 0; i < 30; i++) chain[`p${i}`] = [`p${i + 1}`, `q${i}`, `r${i}`];
		expect(rollbackOrder(chain, "p0")).toHaveLength(MAX_LINKS);
	});
});
