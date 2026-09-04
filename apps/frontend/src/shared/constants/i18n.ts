/**
 * Internationalization constants
 * Available languages and display labels
 */

export type SupportedLanguage = "en" | "fr";

export const AVAILABLE_LANGUAGES = [
	{ value: "en" as const, label: "English", nativeLabel: "English" },
	{ value: "fr" as const, label: "French", nativeLabel: "Français" },
] as const;

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

/**
 * The language to start in when the user has not picked one yet.
 *
 * The app shipped English until someone found Settings → Language, which is a
 * poor first impression in a product translated into both: a French desktop
 * has been saying `fr` all along. Only the primary subtag is read, so `fr-CA`
 * and `fr-FR` land in the same place, and anything not translated falls back
 * to English rather than to a half-translated screen.
 */
export function resolveInterfaceLanguage(
	locales: readonly string[],
): SupportedLanguage {
	for (const locale of locales) {
		const primary = locale.toLowerCase().split(/[-_]/)[0];
		const match = AVAILABLE_LANGUAGES.find(
			(language) => language.value === primary,
		);
		if (match) return match.value;
	}
	return DEFAULT_LANGUAGE;
}
