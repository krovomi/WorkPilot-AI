import { describe, expect, it } from "vitest";
import { getDisplayProgress } from "../utils";

describe("getDisplayProgress", () => {
	it("renvoie l'avancement par sous-tâches hors exécution active", () => {
		expect(getDisplayProgress(25, 74, false)).toBe(25);
	});

	it("privilégie la progression temps réel pendant une exécution active", () => {
		// Cas du bug : sous-tâches figées à 25% alors que le backend est à 74%.
		expect(getDisplayProgress(25, 74, true)).toBe(74);
	});

	it("se replie sur les sous-tâches si overallProgress est absent", () => {
		expect(getDisplayProgress(25, undefined, true)).toBe(25);
	});

	it("ne régresse jamais sous l'avancement par sous-tâches", () => {
		expect(getDisplayProgress(50, 10, true)).toBe(50);
	});

	it("gère overallProgress à 0 pendant l'exécution", () => {
		expect(getDisplayProgress(0, 0, true)).toBe(0);
	});

	it("plafonne dans la bande de codage quand des sous-tâches de code restent à faire", () => {
		// Bug signalé : QA en boucle d'échec, overallProgress=94 (bande QA) mais
		// 2/3 sous-tâches → on plafonne à la fin de la bande de codage (80).
		expect(getDisplayProgress(67, 94, true, false)).toBe(80);
	});

	it("ne plafonne pas quand toutes les sous-tâches de code sont terminées", () => {
		// Codage terminé + QA en cours : la progression QA (80-95) est légitime et
		// l'emporte sur l'avancement par sous-tâches.
		expect(getDisplayProgress(80, 94, true, true)).toBe(94);
	});

	it("n'a aucun effet sur la phase de codage (overall déjà dans la bande)", () => {
		// Pendant le codage, overall <= 80 : le plafond ne change rien même si des
		// sous-tâches restent à faire.
		expect(getDisplayProgress(50, 65, true, false)).toBe(65);
	});
});
