/**
 * Le résultat d'une commande rapide s'affiche dans un toast : formatOutput
 * le met en texte et le coupe pour qu'un gros résultat ne remplisse pas
 * l'écran.
 */
import { describe, expect, it } from "vitest";
import { formatOutput } from "./QuickCommandBar";

describe("formatOutput", () => {
	it("ne montre rien pour un résultat absent ou vide", () => {
		expect(formatOutput(undefined)).toBe("");
		expect(formatOutput(null)).toBe("");
		expect(formatOutput("   ")).toBe("");
	});

	it("garde un texte court tel quel et sérialise un objet", () => {
		expect(formatOutput("ok\n")).toBe("ok");
		expect(formatOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	it("coupe un résultat trop long", () => {
		const out = formatOutput("x".repeat(5000));
		expect(out.length).toBe(2001);
		expect(out.endsWith("…")).toBe(true);
	});
});
