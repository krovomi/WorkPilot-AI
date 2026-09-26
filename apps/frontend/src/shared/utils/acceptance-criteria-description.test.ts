/**
 * @vitest-environment node
 *
 * Criteria stated inside a description. Node environment on purpose: the
 * module is imported by the main process, where no DOM exists.
 */

import { describe, expect, it } from "vitest";

import { extractAcceptanceCriteriaFromDescription as extract } from "./acceptance-criteria";

describe("extractAcceptanceCriteriaFromDescription", () => {
	it("finds nothing in a description without a criteria section", () => {
		expect(extract("Ajouter un export CSV.\n\n- colonne date")).toEqual([]);
		expect(extract(undefined)).toEqual([]);
		expect(extract("")).toEqual([]);
	});

	it("reads a Markdown heading section up to the next heading", () => {
		const md = [
			"Ajouter un export CSV.",
			"",
			"## Critères d'acceptation",
			"",
			"- Le bouton Exporter est visible",
			"- 3 tentatives maximum",
			"1. Le fichier contient l'en-tête",
			"",
			"## Notes",
			"- pas un critère",
		].join("\n");
		expect(extract(md)).toEqual([
			"Le bouton Exporter est visible",
			"3 tentatives maximum",
			"Le fichier contient l'en-tête",
		]);
	});

	it("reads a bare or bold label line", () => {
		expect(
			extract("Contexte.\n\nCritères d'acceptation :\n- A\n- B\n\nNotes :\nrien"),
		).toEqual(["A", "B"]);
		expect(extract("**Acceptance Criteria**\n- [ ] one\n- [x] two")).toEqual([
			"one",
			"two",
		]);
	});

	it("does not open a section on a sentence that mentions the criteria", () => {
		expect(
			extract("Les critères d'acceptation seront définis plus tard :\n- rien"),
		).toEqual([]);
	});

	it("keeps Gherkin scenario lines", () => {
		const md = "# Critères d'acceptation\nScénario 1 : connexion\nÉtant donné un compte :\nAlors je suis connecté";
		expect(extract(md)).toEqual([
			"Scénario 1 : connexion",
			"Étant donné un compte :",
			"Alors je suis connecté",
		]);
	});

	it("reads an HTML section from a tracker description", () => {
		const html =
			"<div>Intro</div><h2>Critères d&#39;acceptation</h2>" +
			"<ul><li>Premier&nbsp;critère</li><li>Second</li></ul>" +
			"<h2>Hors périmètre</h2><p>autre</p>";
		expect(extract(html)).toEqual(["Premier critère", "Second"]);
	});

	it("reads an HTML bold label", () => {
		const html = "<div><b>Acceptance criteria:</b></div><div>- first</div><div>- second</div>";
		expect(extract(html)).toEqual(["first", "second"]);
	});
});

describe("extractAcceptanceCriteriaFromDescription — mixed content", () => {
	it("reads an HTML section that follows a plain-text prefix", () => {
		const mixed =
			"Contexte en texte brut.\n<h2>Acceptance Criteria</h2><ul><li>one</li><li>two</li></ul>";
		expect(extract(mixed)).toEqual(["one", "two"]);
	});

	it("does not treat a comparison in prose as markup", () => {
		expect(extract("## Acceptance criteria\n- a < b holds\n- c")).toEqual(["a < b holds", "c"]);
	});
});
