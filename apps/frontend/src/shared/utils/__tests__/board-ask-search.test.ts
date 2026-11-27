/**
 * The keyword half of « Interroger le tableau »: any language, folded words,
 * short words matching the longer ones they begin, unspaced scripts by pairs.
 */
import { describe, expect, it } from "vitest";
import { detectLanguages, foldText, KeywordIndex, tokenize } from "../board-ask-search";

const doc = (id: string, title: string, body = "") => ({
	id,
	fields: [
		{ text: title, weight: 3 },
		{ text: body, weight: 1 },
	],
});

describe("tokenize", () => {
	it("folds case and accents and drops common words of several languages", () => {
		expect(foldText("Révisée À l'ÉCRAN")).toBe("revisee a l'ecran");
		expect(tokenize("Comment a été revue la page d'admin ?")).toEqual(["revue", "page", "admin"]);
		expect(tokenize("How was the admin page reworked")).toEqual(["admin", "page", "rework"]);
	});

	it("cuts words to a stem and drops a plural s", () => {
		expect(tokenize("pages administration")).toEqual(["page", "admini"]);
	});

	it("reads scripts without spaces as character pairs", () => {
		expect(tokenize("管理页面")).toEqual(["管理", "理页", "页面"]);
	});
});

describe("KeywordIndex", () => {
	const index = new KeywordIndex([
		doc("a", "Refonte de la page d'administration", "Nouveau back-office"),
		doc("b", "Export CSV des factures"),
		doc("c", "Admin dashboard redesign"),
		doc("d", "管理页面 改版"),
	]);

	it("finds the longer words a short one begins, and the reverse", () => {
		const ids = index.search([{ text: "admin", weight: 1 }], 10).map((h) => h.id);
		expect(ids).toEqual(expect.arrayContaining(["a", "c"]));
		expect(ids).not.toContain("b");
		const reverse = index.search([{ text: "administration", weight: 1 }], 10).map((h) => h.id);
		expect(reverse).toEqual(expect.arrayContaining(["a", "c"]));
	});

	it("ranks a word in the title above the same word in the body", () => {
		const scored = new KeywordIndex([doc("title", "Invoices"), doc("body", "Other", "invoices and more")]);
		expect(scored.search([{ text: "invoice", weight: 1 }], 2).map((h) => h.id)).toEqual(["title", "body"]);
	});

	it("matches unspaced scripts and ignores zero weights and empty queries", () => {
		expect(index.search([{ text: "管理页面", weight: 1 }], 5)[0]?.id).toBe("d");
		expect(index.search([{ text: "admin", weight: 0 }], 5)).toEqual([]);
		expect(index.search([{ text: "the of", weight: 1 }], 5)).toEqual([]);
		expect(index.search([{ text: "admin", weight: 1 }], 0)).toEqual([]);
		expect(new KeywordIndex([]).search([{ text: "admin", weight: 1 }], 5)).toEqual([]);
	});

	it("counts its documents", () => {
		expect(index.size).toBe(4);
	});
});

describe("detectLanguages", () => {
	it("names the languages most tickets are written in", () => {
		expect(
			detectLanguages([
				"Ajouter un export des factures pour les clients",
				"Corriger la page de connexion et le mot de passe",
				"Add an export of the invoices for the customers",
			]),
		).toEqual(["fr", "en"]);
	});

	it("leaves out a language a single ticket in many uses, and texts it cannot tell", () => {
		const texts = [...Array.from({ length: 12 }, () => "Fix the login page and the reset flow"), "Corriger la page de la connexion"];
		expect(detectLanguages(texts)).toEqual(["en"]);
		expect(detectLanguages(["CSV", ""])).toEqual([]);
	});
});
