// @vitest-environment jsdom
/**
 * Modèle du diff : lignes masquées entre deux hunks, portée (fonction) du
 * hunk, disposition choisie (unifiée / côte à côte / auto), chemin du fichier
 * lu dans le patch, appariement des lignes réécrites et choix mémorisé.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	countChanges,
	DIFF_VIEW_MODE_STORAGE_KEY,
	pairChangedLines,
	parseDiff,
	patchFilePath,
	readStoredDiffViewMode,
	resolveDiffLayout,
	SPLIT_MIN_WIDTH,
	storeDiffViewMode,
} from "../diff-model";

describe("parseDiff — en-têtes de hunk", () => {
	it("compte les lignes inchangées avant le premier hunk et entre deux hunks", () => {
		const patch = [
			"@@ -10,3 +10,3 @@ public class OrderService",
			" a",
			"-b",
			"+B",
			" c",
			"@@ -40,2 +40,2 @@ public void Pay()",
			"-x",
			"+X",
			" y",
		].join("\n");
		const hunks = parseDiff(patch).filter((line) => line.type === "hunk");
		// Lignes 1 à 9 masquées, puis 13 à 39.
		expect(hunks[0]).toMatchObject({
			hiddenBefore: 9,
			range: "@@ -10,3 +10,3 @@",
			section: "public class OrderService",
		});
		expect(hunks[1]).toMatchObject({ hiddenBefore: 27, section: "public void Pay()" });
	});

	it("ne masque rien avant un fichier nouveau (@@ -0,0)", () => {
		const [hunk] = parseDiff(["@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"));
		expect(hunk).toMatchObject({ type: "hunk", hiddenBefore: 0 });
		expect(hunk.section).toBeUndefined();
	});

	it("compte la ligne d'ancrage d'une insertion pure (-5,0)", () => {
		const [hunk] = parseDiff(["@@ -5,0 +6,1 @@", "+inserted"].join("\n"));
		expect(hunk.hiddenBefore).toBe(5);
	});

	it("repart de zéro à chaque fichier d'un patch multi-fichiers", () => {
		const patch = [
			"diff --git a/a.ts b/a.ts",
			"@@ -20,1 +20,1 @@",
			"-a",
			"+b",
			"diff --git a/b.ts b/b.ts",
			"@@ -3,1 +3,1 @@",
			"-c",
			"+d",
		].join("\n");
		const hunks = parseDiff(patch).filter((line) => line.type === "hunk");
		expect(hunks.map((hunk) => hunk.hiddenBefore)).toEqual([19, 2]);
	});

	it("ignore les fins de ligne CRLF", () => {
		const lines = parseDiff("@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n");
		expect(lines.map((line) => line.content)).toEqual(["@@ -1,1 +1,1 @@", "old", "new"]);
	});
});

describe("resolveDiffLayout", () => {
	const both = { additions: 3, deletions: 2 };

	it("garde une seule colonne pour un fichier ajouté ou supprimé, même en côte à côte", () => {
		expect(resolveDiffLayout("split", { additions: 149, deletions: 0 }, 2000)).toBe("unified");
		expect(resolveDiffLayout("auto", { additions: 0, deletions: 12 }, 2000)).toBe("unified");
	});

	it("auto : côte à côte seulement quand la vue est assez large", () => {
		expect(resolveDiffLayout("auto", both, SPLIT_MIN_WIDTH)).toBe("split");
		expect(resolveDiffLayout("auto", both, SPLIT_MIN_WIDTH - 1)).toBe("unified");
		expect(resolveDiffLayout("auto", both, undefined)).toBe("unified");
	});

	it("respecte un choix explicite", () => {
		expect(resolveDiffLayout("split", both, 300)).toBe("split");
		expect(resolveDiffLayout("unified", both, 3000)).toBe("unified");
	});
});

describe("patchFilePath", () => {
	it("lit le chemin cible, ou le chemin source d'un fichier supprimé", () => {
		expect(patchFilePath("--- a/src/A.cs\n+++ b/src/A.cs\n@@ -1 +1 @@")).toBe("src/A.cs");
		expect(patchFilePath("--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@")).toBe("new.py");
		expect(patchFilePath("--- a/old.go\n+++ /dev/null\n@@ -1 +0,0 @@")).toBe("old.go");
	});

	it("ne devine pas pour un patch sans en-tête ni pour plusieurs fichiers", () => {
		expect(patchFilePath("@@ -1 +1 @@\n-a\n+b")).toBeUndefined();
		expect(
			patchFilePath(
				"diff --git a/a.ts b/a.ts\n+++ b/a.ts\ndiff --git a/b.ts b/b.ts\n+++ b/b.ts",
			),
		).toBeUndefined();
	});
});

describe("pairChangedLines / countChanges", () => {
	it("apparie la k-ième suppression à la k-ième addition d'un bloc", () => {
		const lines = parseDiff(["@@ -1,2 +1,3 @@", "-a", "-b", "+A", "+B", "+C"].join("\n"));
		const pairs = pairChangedLines(lines);
		expect(pairs.get(1)).toBe(3);
		expect(pairs.get(2)).toBe(4);
		expect(pairs.get(4)).toBe(2);
		expect(pairs.has(5)).toBe(false);
		expect(countChanges(lines)).toEqual({ additions: 3, deletions: 2 });
	});
});

describe("choix de disposition mémorisé", () => {
	afterEach(() => localStorage.clear());

	it("vaut auto par défaut et relit les anciennes valeurs", () => {
		expect(readStoredDiffViewMode()).toBe("auto");
		localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, "split");
		expect(readStoredDiffViewMode()).toBe("split");
		storeDiffViewMode("unified");
		expect(readStoredDiffViewMode()).toBe("unified");
		storeDiffViewMode("auto");
		expect(readStoredDiffViewMode()).toBe("auto");
	});
});
