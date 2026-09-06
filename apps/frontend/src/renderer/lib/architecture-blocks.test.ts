import { describe, expect, it } from "vitest";
import {
	BLOCK_CATEGORIES,
	blockAccent,
	blockMeta,
	filterBlocks,
	FRAMEWORKS_BY_TYPE,
	needsFramework,
} from "./architecture-blocks";
import { hasRole } from "./architecture-spec";

const allBlocks = BLOCK_CATEGORIES.flatMap((c) => c.blocks);
/** Stand-in for i18n: the identity, so the tests search raw keys. */
const identity = (key: string) => key;

describe("catalogue", () => {
	it("has no duplicate type — the type is the node's stored identity", () => {
		const types = allBlocks.map((b) => b.type);
		expect(new Set(types).size).toBe(types.length);
	});

	it("gives every block an icon and an accent", () => {
		for (const block of allBlocks) {
			expect(block.icon, block.type).toBeTruthy();
			expect(block.accent, block.type).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("every type is a role the spec builder can name", () => {
		// A block the spec cannot describe reaches the coding agent as a
		// capitalised identifier ("Messagebroker") where a role should be, in
		// both languages. Adding a palette entry without a role is silent.
		for (const block of allBlocks) {
			expect(hasRole(block.type), block.type).toBe(true);
		}
	});

	it("only offers stacks for types that have a meaningful choice", () => {
		for (const type of Object.keys(FRAMEWORKS_BY_TYPE)) {
			expect(blockMeta(type), type).toBeDefined();
			expect(needsFramework(type)).toBe(true);
		}
		expect(needsFramework("custom")).toBe(false);
	});
});

describe("blockMeta / blockAccent", () => {
	it("resolves a known type", () => {
		expect(blockMeta("database")?.labelKey).toBe("database");
	});

	it("returns undefined for an untyped or unknown node", () => {
		expect(blockMeta(undefined)).toBeUndefined();
		expect(blockMeta("nope")).toBeUndefined();
	});

	it("still gives an unknown type a colour, so a node is never unpainted", () => {
		expect(blockAccent("nope")).toMatch(/^#[0-9a-f]{6}$/i);
	});
});

describe("filterBlocks", () => {
	it("returns everything for an empty query", () => {
		expect(filterBlocks("", identity)).toEqual(BLOCK_CATEGORIES);
		expect(filterBlocks("   ", identity)).toEqual(BLOCK_CATEGORIES);
	});

	it("matches the type id", () => {
		const found = filterBlocks("database", identity).flatMap((c) => c.blocks);
		expect(found.map((b) => b.type)).toContain("database");
	});

	it("matches the translated label, not only the key", () => {
		const resolve = (key: string) =>
			key === "auth" ? "Authentification" : key;
		const found = filterBlocks("authentif", resolve).flatMap((c) => c.blocks);
		expect(found.map((b) => b.type)).toEqual(["auth"]);
	});

	it("ignores case and accents", () => {
		const resolve = (key: string) =>
			key === "categoryData" ? "Données & File d'attente" : key;
		const found = filterBlocks("DONNEES", resolve);
		expect(found.flatMap((c) => c.blocks).length).toBeGreaterThan(0);
	});

	it("drops categories left empty rather than rendering a bare heading", () => {
		for (const cat of filterBlocks("database", identity)) {
			expect(cat.blocks.length).toBeGreaterThan(0);
		}
	});

	it("returns nothing for a query that matches nothing", () => {
		expect(filterBlocks("zzzzz", identity)).toEqual([]);
	});
});
