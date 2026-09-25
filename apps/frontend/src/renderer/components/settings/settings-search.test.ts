import { describe, expect, it } from "vitest";
import {
	filterSettingsThemes,
	normalizeForSearch,
	type SettingsNavTheme,
} from "./settings-search";

const Icon = () => null;

function theme(
	title: string,
	description: string,
	priority: number,
	labels: string[],
): SettingsNavTheme {
	return {
		title,
		description,
		priority,
		icon: Icon,
		color: "text-blue-600",
		sections: labels.map((label) => ({
			id: label.toLowerCase(),
			icon: Icon,
			label,
			type: "app" as const,
		})),
	};
}

const THEMES: Record<string, SettingsNavTheme> = {
	system: theme("Système & Maintenance", "Maintenance et système", 6, [
		"Notifications",
		"Debug",
	]),
	project: theme("Projet", "Configuration du projet actuel", 1, ["Général"]),
	interface: theme("Interface & Apparence", "Personnalisation de l'interface", 3, [
		"Apparence",
		"Affichage",
		"Langue",
	]),
};

describe("normalizeForSearch", () => {
	it("ignores case and diacritics", () => {
		expect(normalizeForSearch("Général")).toBe("general");
		expect(normalizeForSearch("SÉCURITÉ")).toBe("securite");
	});
});

describe("filterSettingsThemes", () => {
	it("returns every theme in priority order when the query is empty", () => {
		expect(filterSettingsThemes(THEMES, "").map(([key]) => key)).toEqual([
			"project",
			"interface",
			"system",
		]);
	});

	it("treats a whitespace-only query as no query", () => {
		expect(filterSettingsThemes(THEMES, "   ")).toHaveLength(
			Object.keys(THEMES).length,
		);
	});

	it("keeps only the sections whose label matches", () => {
		const result = filterSettingsThemes(THEMES, "affich");
		expect(result).toHaveLength(1);
		const [key, matched] = result[0];
		expect(key).toBe("interface");
		expect(matched.sections.map((s) => s.label)).toEqual(["Affichage"]);
	});

	it("matches a section label written without its accents", () => {
		const [[key, matched]] = filterSettingsThemes(THEMES, "general");
		expect(key).toBe("project");
		expect(matched.sections.map((s) => s.label)).toEqual(["Général"]);
	});

	it("keeps all the sections of a theme matched by its own title", () => {
		const [[key, matched]] = filterSettingsThemes(THEMES, "interface");
		expect(key).toBe("interface");
		expect(matched.sections).toHaveLength(3);
	});

	it("matches a theme on its description too", () => {
		const [[key]] = filterSettingsThemes(THEMES, "personnalisation");
		expect(key).toBe("interface");
	});

	it("drops a theme no section of which matches", () => {
		expect(filterSettingsThemes(THEMES, "zzz")).toEqual([]);
	});

	it("never mutates the themes it was given", () => {
		filterSettingsThemes(THEMES, "affich");
		expect(THEMES.interface.sections).toHaveLength(3);
	});
});
