import type { ElementType } from "react";

/**
 * Le filtre de la navigation des paramètres, à part du composant : la question
 * « ce libellé correspond-il à ce qu'on cherche ? » se teste sans monter un
 * dialogue qui rend, lui, la page de réglages active.
 */

/** Une entrée cliquable de la navigation — une page de réglages. */
export interface SettingsNavSection {
	id: string;
	icon: ElementType;
	label: string;
	type: "app" | "project";
}

/** Un groupe de sections, tel que `createSettingsThemes` le produit. */
export interface SettingsNavTheme {
	title: string;
	icon: ElementType;
	color: string;
	sections: SettingsNavSection[];
	description: string;
	priority: number;
}

/** Un thème et sa clé, dans l'ordre où la navigation les affiche. */
export type SettingsThemeEntry = [string, SettingsNavTheme];

/**
 * Minuscules et accents retirés : « general » doit trouver « Général », et
 * « securite » « Sécurité & Performance ». Sans cela, le filtre ne répond qu'à
 * qui tape déjà le libellé exact — ce qu'il existe précisément pour éviter.
 */
export function normalizeForSearch(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
}

/**
 * Trie les thèmes par priorité et les réduit à ce que la requête désigne.
 *
 * Un thème dont le titre ou la description correspond garde **toutes** ses
 * sections : la requête a désigné le groupe entier, et n'en montrer qu'une
 * partie serait répondre à une autre question. Un thème dont plus aucune
 * section ne correspond disparaît.
 *
 * Une requête vide rend la liste complète, dans l'ordre d'affichage.
 */
export function filterSettingsThemes(
	themes: Record<string, SettingsNavTheme>,
	query: string,
): SettingsThemeEntry[] {
	const term = normalizeForSearch(query.trim());
	const ordered: SettingsThemeEntry[] = Object.entries(themes).sort(
		([, a], [, b]) => a.priority - b.priority,
	);

	if (!term) return ordered;

	return ordered
		.map(([themeKey, theme]): SettingsThemeEntry => {
			const themeMatches =
				normalizeForSearch(theme.title).includes(term) ||
				normalizeForSearch(theme.description).includes(term);
			if (themeMatches) return [themeKey, theme];
			return [
				themeKey,
				{
					...theme,
					sections: theme.sections.filter((section) =>
						normalizeForSearch(section.label).includes(term),
					),
				},
			];
		})
		.filter(([, theme]) => theme.sections.length > 0);
}
