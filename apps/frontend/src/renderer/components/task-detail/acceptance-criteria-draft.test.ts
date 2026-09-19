/**
 * Les règles du brouillon en puces, sans React.
 *
 * Ce qui est testé ici est ce qui décidait autrefois du contenu d'un textarea :
 * ce qu'on garde en enregistrant, ce qu'un collage produit, ce qu'un
 * déplacement fait aux bords. Le composant, lui, est testé pour le focus.
 */

import { describe, expect, it } from "vitest";
import {
	createDraft,
	draftsToText,
	ensureAtLeastOne,
	insertAt,
	moveItem,
	removeAt,
	sameCriteria,
	splitPastedCriteria,
	stripBulletMarker,
	textToDrafts,
	toCriteria,
	toDrafts,
	updateAt,
} from "./acceptance-criteria-draft";

describe("stripBulletMarker", () => {
	it("removes the markers a pasted list carries", () => {
		expect(stripBulletMarker("- le login échoue")).toBe("le login échoue");
		expect(stripBulletMarker("  • le login échoue")).toBe("le login échoue");
		expect(stripBulletMarker("1. le login échoue")).toBe("le login échoue");
		expect(stripBulletMarker("2) le login échoue")).toBe("le login échoue");
	});

	it("keeps a number that is part of the sentence", () => {
		// « 3 tentatives » n'est pas une liste numérotée : le marqueur doit
		// être suivi d'un point ou d'une parenthèse pour en être un.
		expect(stripBulletMarker("3 tentatives maximum")).toBe(
			"3 tentatives maximum",
		);
		expect(stripBulletMarker("-1 est refusé")).toBe("-1 est refusé");
	});
});

describe("toCriteria", () => {
	it("drops the empty line a fresh bullet starts as", () => {
		const drafts = [createDraft("premier"), createDraft(""), createDraft("  ")];
		expect(toCriteria(drafts)).toEqual(["premier"]);
	});

	it("keeps a criterion on one line whatever got dropped into it", () => {
		// Un glisser-déposer de texte n'appuie sur aucune touche : le champ
		// peut donc contenir un retour à la ligne que l'éditeur n'a pas vu.
		expect(toCriteria([createDraft("un\ndeux")])).toEqual(["un deux"]);
	});

	it("strips a marker the user typed by hand", () => {
		expect(toCriteria([createDraft("- déjà à puces")])).toEqual([
			"déjà à puces",
		]);
	});
});

describe("ids", () => {
	it("gives two identical criteria two identities", () => {
		// Un id dérivé du texte ferait de deux critères identiques une seule
		// ligne pour React — et la seconde perdrait le focus à chaque frappe.
		const [a, b] = toDrafts(["même", "même"]);
		expect(a.id).not.toBe(b.id);
	});
});

describe("round-trip between the two modes", () => {
	it("keeps a line the user has opened but not filled", () => {
		const drafts = [createDraft("premier"), createDraft("")];
		expect(draftsToText(drafts)).toBe("premier\n");
	});

	it("turns the text back into one bullet per line", () => {
		expect(textToDrafts("un\n\n- deux\n").map((d) => d.text)).toEqual([
			"un",
			"deux",
		]);
	});
});

describe("splitPastedCriteria", () => {
	it("makes one criterion per pasted line", () => {
		expect(splitPastedCriteria("- un\n- deux\n\n3. trois")).toEqual([
			"un",
			"deux",
			"trois",
		]);
	});

	it("leaves angle brackets alone", () => {
		// Contrairement à la lecture des trackers, ce qui arrive ici est du
		// texte : « < 200ms > seuil » n'est pas une balise à retirer.
		expect(splitPastedCriteria("temps de réponse < 200ms > seuil")).toEqual([
			"temps de réponse < 200ms > seuil",
		]);
	});
});

describe("list edits", () => {
	const base = toDrafts(["un", "deux", "trois"]);

	it("inserts after the given position", () => {
		const next = insertAt(base, 1, [createDraft("un et demi")]);
		expect(next.map((d) => d.text)).toEqual([
			"un",
			"un et demi",
			"deux",
			"trois",
		]);
	});

	it("removes and updates by position", () => {
		expect(removeAt(base, 0).map((d) => d.text)).toEqual(["deux", "trois"]);
		expect(updateAt(base, 2, "TROIS").map((d) => d.text)).toEqual([
			"un",
			"deux",
			"TROIS",
		]);
	});

	it("moves an item without wrapping around at the edges", () => {
		expect(moveItem(base, 2, 0).map((d) => d.text)).toEqual([
			"trois",
			"un",
			"deux",
		]);
		// Flèche vers le haut sur la première ligne : rien, surtout pas un
		// saut à la fin de la liste.
		expect(moveItem(base, 0, -1).map((d) => d.text)).toEqual([
			"un",
			"deux",
			"trois",
		]);
		expect(moveItem(base, 2, 3).map((d) => d.text)).toEqual([
			"un",
			"deux",
			"trois",
		]);
	});

	it("keeps identity across an edit, so the focus stays put", () => {
		expect(updateAt(base, 1, "DEUX")[1].id).toBe(base[1].id);
	});

	it("always leaves somewhere to type", () => {
		expect(ensureAtLeastOne([])).toHaveLength(1);
		expect(ensureAtLeastOne(base)).toHaveLength(3);
	});
});

describe("sameCriteria", () => {
	it("compares content and order", () => {
		expect(sameCriteria(["a", "b"], ["a", "b"])).toBe(true);
		expect(sameCriteria(["a", "b"], ["b", "a"])).toBe(false);
		expect(sameCriteria(["a"], ["a", "b"])).toBe(false);
	});
});
