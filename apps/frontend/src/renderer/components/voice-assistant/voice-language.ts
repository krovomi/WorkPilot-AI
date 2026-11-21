/** The language the assistant transcribes in: chosen in its panel, kept between sessions. */

export const LANGUAGES = ["auto", "fr-FR", "en-US", "en-GB", "es-ES", "de-DE", "it-IT", "pt-BR", "nl-NL"];
export const LANGUAGE_KEY = "voice-assistant-language";

export function initialLanguage(appLanguage: string): string {
	try {
		const saved = localStorage.getItem(LANGUAGE_KEY);
		if (saved && LANGUAGES.includes(saved)) return saved;
	} catch {
		/* Storage can be disabled. */
	}
	return LANGUAGES.find((lang) => lang.startsWith(appLanguage.split("-")[0])) ?? "auto";
}
