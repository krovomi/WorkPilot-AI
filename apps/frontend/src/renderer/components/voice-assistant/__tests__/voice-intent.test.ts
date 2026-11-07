import { describe, expect, it } from "vitest";
import { normalizeSpeech, readVoiceCommand, titleFrom } from "../voice-intent";

const FR = [
	{ id: "kanban", label: "Tableau Kanban" },
	{ id: "visual-to-code", label: "Visuel vers Code" },
	{ id: "architecture-visualizer", label: "Visualiseur d'architecture" },
	{ id: "insights", label: "Analyses" },
	{ id: "accessibility-agent", label: "Analyse d'accessibilité" },
	{ id: "roadmap", label: "Feuille de route" },
	{ id: "terminals", label: "Terminaux Agent" },
];
const EN = [
	{ id: "kanban", label: "Kanban Board" },
	{ id: "visual-to-code", label: "Visual to Code" },
	{ id: "roadmap", label: "Roadmap" },
];

describe("normalizeSpeech", () => {
	it("folds case, accents and typographic apostrophes", () => {
		expect(normalizeSpeech("  Crée-moi   l’Idée  ")).toBe("cree-moi l'idee");
	});
});

describe("readVoiceCommand — create a task", () => {
	it("takes the task text after the request formula, in the speaker's spelling", () => {
		const reading = readVoiceCommand(
			"Crée-moi une tâche dans le kanban pour corriger le bug de connexion à Azure.",
			FR,
		);
		expect(reading).toEqual({
			confident: true,
			intent: {
				kind: "create-task",
				title: "Corriger le bug de connexion à Azure",
				description: "corriger le bug de connexion à Azure",
			},
		});
	});

	it("understands polite and English forms", () => {
		expect(
			readVoiceCommand("Est-ce que tu peux ajouter une nouvelle tâche : migrer vers .NET 11", FR)
				.intent,
		).toMatchObject({ kind: "create-task", description: "migrer vers .NET 11" });
		expect(readVoiceCommand("Please create a task to add dark mode", EN).intent).toMatchObject({
			kind: "create-task",
			title: "Add dark mode",
		});
		expect(readVoiceCommand("add a card to the board for the login page", EN).intent).toMatchObject({
			kind: "create-task",
			description: "the login page",
		});
	});

	it("opens the empty form when nothing follows", () => {
		expect(readVoiceCommand("Crée une tâche", FR).intent).toEqual({ kind: "new-task" });
		expect(readVoiceCommand("nouvelle tâche", FR).intent).toEqual({ kind: "new-task" });
	});
});

describe("readVoiceCommand — navigate", () => {
	it("opens a view named by its label", () => {
		expect(readVoiceCommand("Ouvre Visuel vers Code", FR)).toEqual({
			confident: true,
			intent: { kind: "navigate", view: "visual-to-code" },
		});
		expect(readVoiceCommand("roadmap", EN)).toEqual({
			confident: true,
			intent: { kind: "navigate", view: "roadmap" },
		});
	});

	it("finds a view by its purpose when a verb asks for it", () => {
		expect(
			readVoiceCommand("ouvre-moi la feature qui me permet de dessiner une architecture", FR),
		).toEqual({ confident: true, intent: { kind: "navigate", view: "visual-to-code" } });
		expect(readVoiceCommand("va au kanban", FR).intent).toEqual({ kind: "navigate", view: "kanban" });
	});

	it("matches whole words only, so « Analyses » does not catch « analyse d'accessibilité »", () => {
		expect(readVoiceCommand("ouvre l'analyse d'accessibilité", FR).intent).toEqual({
			kind: "navigate",
			view: "accessibility-agent",
		});
	});

	it("leaves an unsure sentence to the model", () => {
		expect(readVoiceCommand("un truc pour les schémas", FR).confident).toBe(false);
		expect(readVoiceCommand("quelle heure est-il", FR)).toEqual({
			confident: false,
			intent: { kind: "unknown" },
		});
	});

	it("never offers a view the sidebar does not list", () => {
		expect(readVoiceCommand("ouvre la feuille de route", [EN[0]]).intent).toEqual({ kind: "unknown" });
	});

	it("opens the settings", () => {
		expect(readVoiceCommand("ouvre les paramètres", FR).intent).toEqual({ kind: "open-settings" });
		expect(readVoiceCommand("Settings", EN).intent).toEqual({ kind: "open-settings" });
	});
});

describe("titleFrom", () => {
	it("keeps the first clause, capitalised, within 80 characters", () => {
		expect(titleFrom("ajouter un export CSV. Puis le tester")).toBe("Ajouter un export CSV");
		const long = titleFrom(`${"mot ".repeat(40)}fin`);
		expect(long.length).toBeLessThanOrEqual(80);
		expect(long.endsWith("mot")).toBe(true);
	});
});
