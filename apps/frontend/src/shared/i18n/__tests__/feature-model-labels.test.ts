/**
 * « Paramètres de modèle par fonctionnalité » (Réglages → Agent) lisait ses
 * libellés dans une table anglaise en dur (`FEATURE_LABELS`) et les niveaux de
 * réflexion dans `THINKING_LEVELS[].label` : la rubrique restait en anglais
 * dans une interface en français. Ils passent désormais par
 * `settings:general.features.<feature>` et `settings:general.thinkingLevels`.
 *
 * Ce qui est épinglé ici : une fonctionnalité ou un niveau ajouté au code sans
 * sa traduction, dans l'une ou l'autre langue, casse le build plutôt que
 * d'afficher une clé brute.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_FEATURE_MODELS,
	THINKING_LEVELS,
} from "../../constants/models";
import enSettings from "../locales/en/settings.json";
import frSettings from "../locales/fr/settings.json";

const LOCALES = { en: enSettings, fr: frSettings };

describe.each(Object.entries(LOCALES))("settings (%s)", (_lang, settings) => {
	const { features, thinkingLevels } = settings.general as {
		features: Record<string, { label?: string; description?: string }>;
		thinkingLevels: Record<string, string>;
	};

	it.each(Object.keys(DEFAULT_FEATURE_MODELS))("names the feature %s", (feature) => {
		expect(features[feature]?.label?.trim()).toBeTruthy();
		expect(features[feature]?.description?.trim()).toBeTruthy();
	});

	it.each(THINKING_LEVELS.map((level) => level.value))(
		"names the thinking level %s",
		(level) => {
			expect(thinkingLevels[level]?.trim()).toBeTruthy();
		},
	);
});

it("translates the feature names, not only copies them", () => {
	const en = enSettings.general.features as Record<string, { label: string }>;
	const fr = frSettings.general.features as Record<string, { label: string }>;
	const translated = Object.keys(en).filter(
		(feature) => en[feature].label !== fr[feature]?.label,
	);
	// "Roadmap" reads the same in both languages; the rest must not.
	expect(translated.length).toBeGreaterThanOrEqual(Object.keys(en).length - 1);
});
