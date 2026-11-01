/**
 * The app's languages: English and French, like the desktop (rule 9: every
 * visible text in `en` and `fr`). The device's language picks one; any other
 * falls back to English.
 */

import { getLocales } from "expo-localization";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { ApiError } from "../api/client";
import en from "./en.json";
import fr from "./fr.json";

export const resources = { en: { translation: en }, fr: { translation: fr } } as const;
export const LANGUAGES = Object.keys(resources) as (keyof typeof resources)[];

/** The first of the device's languages the app speaks, else English. */
export function pickLanguage(codes: readonly (string | null | undefined)[]): keyof typeof resources {
	for (const code of codes) {
		const base = code?.toLowerCase().split(/[-_]/)[0];
		if (base && (LANGUAGES as string[]).includes(base)) return base as keyof typeof resources;
	}
	return "en";
}

if (!i18n.isInitialized) {
	void i18n.use(initReactI18next).init({
		resources,
		lng: pickLanguage(getLocales().map((l) => l.languageCode)),
		fallbackLng: "en",
		interpolation: { escapeValue: false },
		returnNull: false,
	});
}

/** A failure as a sentence for the person, in their language. */
export function describeError(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.status === 0) return i18n.t(err.message === "timeout" ? "errors.timeout" : "errors.network");
		if (err.status === 401) return i18n.t("errors.signed_out");
		if (err.status === 403) return i18n.t("errors.forbidden");
		return i18n.t("errors.generic", { message: err.message });
	}
	if (err instanceof Error && i18n.exists(`errors.${err.message}`)) return i18n.t(`errors.${err.message}`);
	return i18n.t("errors.generic", { message: err instanceof Error ? err.message : String(err) });
}

export default i18n;
