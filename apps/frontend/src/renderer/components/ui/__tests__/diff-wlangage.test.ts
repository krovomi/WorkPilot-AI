/**
 * WLangage dans la vue des diffs : un élément WinDev au format texte est
 * reconnu par son extension, le code WLangage est coloré (mots-clés français
 * ou anglais, chaînes, commentaires, types) et les valeurs que seul l'éditeur
 * écrit (`internal_properties`, `identifier`) sont atténuées.
 */
import { describe, expect, it } from "vitest";
import { parseDiff } from "../diff-model";
import { findLanguage, highlightDiffLines } from "../diff-syntax";

async function tokensOf(path: string, patch: string[]) {
	const description = findLanguage(path);
	if (!description) throw new Error(`no grammar for ${path}`);
	const parser = (await description.load()).language.parser;
	const lines = parseDiff(patch.join("\n"));
	const tokens = highlightDiffLines(lines, parser);
	return (index: number, text: string) => {
		const content = lines[index].content;
		return (tokens.get(index) ?? [])
			.filter((token) => content.slice(token.from, token.to) === text)
			.map((token) => token.className);
	};
}

describe("WLangage", () => {
	it.each(["FEN_Clients.wdw", "src/COL_Clients.WDG", "Gestion.wdp", "PAGE_Accueil.wwh"])(
		"%s est lu en WLangage",
		(path) => {
			expect(findLanguage(path)?.name).toBe("WLangage");
		},
	);

	it("colore le code et atténue les propriétés de l'éditeur", async () => {
		const classesOf = await tokensOf("FEN_Clients.wdw", [
			"@@ -1,6 +1,7 @@",
			"     name : BTN_Valider",
			"     internal_properties : BgAAAAYAAACwzbWS7TqtmQ22ck",
			"     code : |1+",
			'      SI nMontant <= 0 ALORS Info("Montant nul") // garde',
			"-      RENVOYER Vrai",
			"+      nTotal est un entier = 42",
			"+      IF bOk THEN RETURN False",
		]);
		expect(classesOf(1, "name")[0]).toContain("tok-propertyName");
		expect(classesOf(2, "internal_properties")[0]).toContain("tok-meta");
		expect(classesOf(2, "BgAAAAYAAACwzbWS7TqtmQ22ck")[0]).toContain("tok-meta");
		expect(classesOf(3, "|1+")[0]).toContain("tok-meta");
		expect(classesOf(4, "SI")[0]).toContain("tok-keyword");
		expect(classesOf(4, "ALORS")[0]).toContain("tok-keyword");
		expect(classesOf(4, '"Montant nul"')[0]).toContain("tok-string");
		expect(classesOf(4, "// garde")[0]).toContain("tok-comment");
		expect(classesOf(5, "RENVOYER")[0]).toContain("tok-keyword");
		expect(classesOf(5, "Vrai")[0]).toContain("tok-bool");
		expect(classesOf(6, "entier")[0]).toContain("tok-typeName");
		expect(classesOf(6, "42")[0]).toContain("tok-number");
		expect(classesOf(7, "THEN")[0]).toContain("tok-keyword");
	});

	it("garde un commentaire sur plusieurs lignes", async () => {
		const classesOf = await tokensOf("COL_Clients.wdg", [
			"@@ -0,0 +1,3 @@",
			"+      /* début",
			"+      suite SI */",
			"+      Ferme()",
		]);
		expect(classesOf(2, "      suite SI */")[0]).toContain("tok-comment");
		expect(classesOf(3, "Ferme")[0]).toContain("tok-variableName");
	});
});
