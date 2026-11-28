/**
 * The MCP install policy: a closed schema where anything unexpected is the
 * strictest policy, said invalid; and the refusal it makes of a server.
 */
import { describe, expect, it } from "vitest";
import type { McpMarketplaceServer } from "../../types/mcp-marketplace";
import { loadMcpCatalog } from "../install";
import {
	acceptedFindings,
	invalidPolicy,
	parseMcpPolicy,
	policyConfines,
	policyNeedsScore,
	policyRefusal,
	STRICTEST_POLICY,
} from "../install-policy";

/** A policy with one accepted finding, `over` replacing its fields. */
function finding(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		acceptedFindings: [{ server: "github", rule: "dynamicCode", reason: "reviewed", ...over }],
	});
}

const github = loadMcpCatalog().find((s) => s.id === "github") as McpMarketplaceServer;

describe("parseMcpPolicy", () => {
	it("reads a full policy, ids once each", () => {
		expect(
			parseMcpPolicy(
				JSON.stringify({
					version: 1,
					allowedServers: ["github", "sentry", "github"],
					minScore: 60,
					blockCustomServers: true,
				}),
			),
		).toEqual({
			state: "active",
			policy: { allowedServers: ["github", "sentry"], minScore: 60, blockCustomServers: true },
		});
	});

	it("reads an empty policy as allowing everything but saying it exists", () => {
		expect(parseMcpPolicy("{}")).toEqual({
			state: "active",
			policy: { blockCustomServers: false },
		});
	});

	it("is invalid, and the strictest, for anything unexpected", () => {
		const cases: [string, string, string?][] = [
			["not json", "notJson"],
			["[]", "schema"],
			['"x"', "schema"],
			['{"allowServers": []}', "schema", "allowServers"],
			['{"version": 2}', "schema", "version"],
			['{"allowedServers": "github"}', "schema", "allowedServers"],
			['{"allowedServers": ["../x"]}', "schema", "allowedServers"],
			['{"allowedServers": [3]}', "schema", "allowedServers"],
			[JSON.stringify({ allowedServers: Array(501).fill("a") }), "schema", "allowedServers"],
			['{"minScore": 101}', "schema", "minScore"],
			['{"minScore": -1}', "schema", "minScore"],
			['{"minScore": 50.5}', "schema", "minScore"],
			['{"minScore": "60"}', "schema", "minScore"],
			['{"confineBelow": 101}', "schema", "confineBelow"],
			['{"confineBelow": 49.5}', "schema", "confineBelow"],
			['{"confineBelow": "50"}', "schema", "confineBelow"],
			['{"blockCustomServers": "yes"}', "schema", "blockCustomServers"],
			['{"acceptedFindings": {}}', "schema", "acceptedFindings"],
			['{"acceptedFindings": ["x"]}', "schema", "acceptedFindings"],
			[finding({ extra: 1 }), "schema", "acceptedFindings"],
			[finding({ server: "../x" }), "schema", "acceptedFindings"],
			[finding({ server: 3 }), "schema", "acceptedFindings"],
			[finding({ rule: "everything" }), "schema", "acceptedFindings"],
			[finding({ rule: 1 }), "schema", "acceptedFindings"],
			[finding({ reason: "   " }), "schema", "acceptedFindings"],
			[finding({ reason: 2 }), "schema", "acceptedFindings"],
			[finding({ reason: "x".repeat(301) }), "schema", "acceptedFindings"],
			[
				JSON.stringify({ acceptedFindings: Array(201).fill(JSON.parse(finding()).acceptedFindings[0]) }),
				"schema",
				"acceptedFindings",
			],
		];
		for (const [text, reason, field] of cases) {
			const state = parseMcpPolicy(text);
			expect(state).toEqual({
				state: "invalid",
				reason,
				...(field ? { field } : {}),
				policy: STRICTEST_POLICY,
			});
		}
	});

	it("reads accepted findings, each with its reason trimmed", () => {
		const state = parseMcpPolicy(finding({ reason: "  loads its own plugins " }));
		expect(state).toEqual({
			state: "active",
			policy: {
				blockCustomServers: false,
				acceptedFindings: [{ server: "github", rule: "dynamicCode", reason: "loads its own plugins" }],
			},
		});
		expect(acceptedFindings(state)).toHaveLength(1);
		expect(acceptedFindings(parseMcpPolicy("{}"))).toEqual([]);
		expect(acceptedFindings(parseMcpPolicy("nope"))).toEqual([]);
		expect(acceptedFindings({ state: "none" })).toEqual([]);
	});

	it("does not echo a field name that is not a plain name", () => {
		const state = parseMcpPolicy(JSON.stringify({ "<img src=x>": 1 }));
		expect(state).toEqual({ state: "invalid", reason: "schema", policy: STRICTEST_POLICY });
	});
});

describe("policyRefusal", () => {
	const subject = { serverId: "github", name: "GitHub", entry: github };

	it("lets anything through without a policy", () => {
		expect(policyRefusal({ state: "none" }, { ...subject, entry: null })).toBeNull();
	});

	it("refuses everything under an invalid policy", () => {
		expect(policyRefusal(invalidPolicy("notJson"), subject)).toEqual({
			reason: "policyInvalid",
			serverId: "github",
			name: "GitHub",
		});
	});

	it("refuses a custom server only when the policy says so", () => {
		const custom = { serverId: "mine", name: "Mine", entry: null };
		expect(policyRefusal({ state: "active", policy: { blockCustomServers: false } }, custom)).toBeNull();
		expect(policyRefusal({ state: "active", policy: { blockCustomServers: true } }, custom)).toEqual({
			reason: "customBlocked",
			serverId: "mine",
			name: "Mine",
		});
	});

	it("refuses a catalog server the list leaves out", () => {
		const only = (ids: string[]) =>
			({ state: "active", policy: { allowedServers: ids, blockCustomServers: false } }) as const;
		expect(policyRefusal(only(["github"]), subject)).toBeNull();
		expect(policyRefusal(only(["sentry"]), subject)?.reason).toBe("notAllowed");
		expect(policyRefusal(only([]), subject)?.reason).toBe("notAllowed");
	});

	it("refuses a score under the minimum, once the score is known", () => {
		const min = { state: "active", policy: { minScore: 70, blockCustomServers: false } } as const;
		expect(policyNeedsScore(min)).toBe(true);
		expect(policyNeedsScore({ state: "active", policy: { blockCustomServers: true } })).toBe(false);
		expect(policyNeedsScore(invalidPolicy("schema"))).toBe(false);
		expect(policyRefusal(min, subject)).toBeNull();
		expect(policyRefusal(min, { ...subject, score: 70 })).toBeNull();
		expect(policyRefusal(min, { ...subject, score: 69 })).toEqual({
			reason: "scoreTooLow",
			serverId: "github",
			name: "GitHub",
			score: 69,
			minScore: 70,
		});
	});

	it("reads confineBelow, and confines a server under it or outside the catalog (lot 5)", () => {
		const state = parseMcpPolicy('{"confineBelow": 50}');
		expect(state).toEqual({ state: "active", policy: { confineBelow: 50, blockCustomServers: false } });
		expect(policyConfines(state, { entry: null })).toBe(true);
		expect(policyConfines(state, { entry: github })).toBe(true);
		expect(policyConfines(state, { entry: github, score: 49 })).toBe(true);
		expect(policyConfines(state, { entry: github, score: 50 })).toBe(false);
		expect(policyConfines(parseMcpPolicy("{}"), { entry: null })).toBe(false);
		expect(policyConfines(invalidPolicy("schema"), { entry: null })).toBe(false);
		expect(policyConfines({ state: "none" }, { entry: null })).toBe(false);
	});
});
