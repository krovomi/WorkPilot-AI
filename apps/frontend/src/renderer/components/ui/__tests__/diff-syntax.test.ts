/**
 * Coloration syntaxique d'un diff : la grammaire suit l'extension (y compris
 * les fichiers .NET que language-data ne liste pas), chaque côté est analysé
 * en entier (un commentaire sur plusieurs lignes reste un commentaire) et les
 * jetons reviennent aux bonnes lignes.
 */
import { describe, expect, it } from "vitest";
import { parseDiff } from "../diff-model";
import { findLanguage, highlightDiffLines } from "../diff-syntax";

describe("findLanguage", () => {
	it.each([
		["src/Domain/Result.cs", "C#"],
		["web/app.tsx", "TSX"],
		["api/main.py", "Python"],
		["cmd/server.go", "Go"],
		["src/lib.rs", "Rust"],
		["App.kt", "Kotlin"],
		["lib/main.dart", "Dart"],
		["src/App.vue", "Vue"],
		["Api.csproj", "XML"],
		["Pages/Index.razor", "HTML"],
		["Views/Home.cshtml", "HTML"],
	])("%s → %s", (path, name) => {
		expect(findLanguage(path)?.name).toBe(name);
	});

	it("ne choisit rien pour un fichier inconnu", () => {
		expect(findLanguage("notes.unknownext")).toBeNull();
	});
});

async function parserFor(path: string) {
	const description = findLanguage(path);
	if (!description) throw new Error(`no grammar for ${path}`);
	return (await description.load()).language.parser;
}

describe("highlightDiffLines", () => {
	it("colore un ajout C# : mots-clés, chaînes, commentaires", async () => {
		const lines = parseDiff(
			[
				"@@ -0,0 +1,3 @@",
				"+using Xunit;",
				'+var name = "Ada"; // greet',
				"+int n = 42;",
			].join("\n"),
		);
		const tokens = highlightDiffLines(lines, await parserFor("A.cs"));
		const classesOf = (index: number, text: string) => {
			const content = lines[index].content;
			return (tokens.get(index) ?? [])
				.filter((token) => content.slice(token.from, token.to) === text)
				.map((token) => token.className);
		};
		expect(classesOf(1, "using")[0]).toContain("tok-keyword");
		expect(classesOf(2, '"Ada"')[0]).toContain("tok-string");
		expect(classesOf(2, "// greet")[0]).toContain("tok-comment");
		expect(classesOf(3, "42")[0]).toContain("tok-number");
	});

	it("garde un commentaire bloc sur plusieurs lignes et sépare les deux côtés", async () => {
		const lines = parseDiff(
			[
				"@@ -1,3 +1,3 @@",
				" /* start",
				"-old text */ const a = 1;",
				"+new text */ const b = 2;",
			].join("\n"),
		);
		const tokens = highlightDiffLines(lines, await parserFor("x.ts"));
		const removed = tokens.get(2) ?? [];
		const added = tokens.get(3) ?? [];
		// "old text */" (côté ancien) et "new text */" (côté nouveau) sont la
		// fin du commentaire ouvert sur la ligne de contexte.
		expect(removed[0]).toMatchObject({ from: 0, className: "tok-comment" });
		expect(added[0]).toMatchObject({ from: 0, className: "tok-comment" });
		expect(added.some((token) => token.className.includes("tok-keyword"))).toBe(
			true,
		);
		// Le contexte est coloré une seule fois, depuis le côté nouveau.
		expect(tokens.get(1)?.[0]).toMatchObject({ from: 0, className: "tok-comment" });
	});
});
