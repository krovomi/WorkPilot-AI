/**
 * Diff mot à mot d'une ligne réécrite, mise en segments (couleur syntaxique +
 * mot changé) et carrés du diffstat.
 */
import { describe, expect, it } from "vitest";
import { diffStatBlocks } from "../diff-stat";
import { splitLine } from "../diff-segments";
import { diffWords } from "../diff-words";

const slice = (text: string, ranges: { from: number; to: number }[]) =>
	ranges.map((range) => text.slice(range.from, range.to));

describe("diffWords", () => {
	it("marque seulement les mots qui changent", () => {
		const before = "var total = order.Amount * 2;";
		const after = "var total = order.Amount * rate;";
		const diff = diffWords(before, after);
		expect(slice(before, diff?.removed ?? [])).toEqual(["2"]);
		expect(slice(after, diff?.added ?? [])).toEqual(["rate"]);
	});

	it("fusionne les mots voisins changés en une seule plage", () => {
		const before = "return a + b;";
		const after = "return Math.max(a, b);";
		const diff = diffWords(before, after);
		expect(diff).not.toBeNull();
		expect(slice(after, diff?.added ?? []).join("|")).toContain("Math.max(");
	});

	it("ne marque rien pour deux lignes sans rapport (au-delà de l'indentation)", () => {
		expect(diffWords("    using Xunit;", "    public class OrderTests")).toBeNull();
	});

	it("ne marque rien pour des lignes identiques ou vides", () => {
		expect(diffWords("same", "same")).toBeNull();
		expect(diffWords("", "added")).toBeNull();
	});

	it("garde les lettres accentuées d'un identifiant ensemble", () => {
		const diff = diffWords("const élément = 1;", "const élément = 2;");
		expect(slice("const élément = 2;", diff?.added ?? [])).toEqual(["2"]);
	});
});

describe("splitLine", () => {
	it("découpe aux bornes des jetons et des mots changés", () => {
		const segments = splitLine(
			"int n = 42;",
			[
				{ from: 0, to: 3, className: "tok-keyword" },
				{ from: 8, to: 10, className: "tok-number" },
			],
			[{ from: 9, to: 10 }],
		);
		expect(segments.map((s) => [s.text, s.className, s.changed])).toEqual([
			["int", "tok-keyword", false],
			[" n = ", undefined, false],
			["4", "tok-number", false],
			["2", "tok-number", true],
			[";", undefined, false],
		]);
		expect(segments.map((s) => s.from)).toEqual([0, 3, 8, 9, 10]);
	});

	it("rend la ligne entière sans jeton ni mot", () => {
		expect(splitLine("plain")).toEqual([{ from: 0, text: "plain", changed: false }]);
	});
});

describe("diffStatBlocks", () => {
	it("répartit cinq carrés selon le poids des ajouts et suppressions", () => {
		expect(diffStatBlocks(149, 0)).toEqual(["add", "add", "add", "add", "add"]);
		expect(diffStatBlocks(0, 3)).toEqual(["del", "del", "del", "del", "del"]);
		expect(diffStatBlocks(6, 4)).toEqual(["add", "add", "add", "del", "del"]);
	});

	it("donne au moins un carré au côté minoritaire", () => {
		expect(diffStatBlocks(1, 200)).toEqual(["add", "del", "del", "del", "del"]);
		expect(diffStatBlocks(200, 1)).toEqual(["add", "add", "add", "add", "del"]);
	});

	it("reste neutre sans changement", () => {
		expect(diffStatBlocks(0, 0)).toEqual(["none", "none", "none", "none", "none"]);
	});
});
