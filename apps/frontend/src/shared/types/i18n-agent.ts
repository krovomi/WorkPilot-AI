/**
 * i18n Agent — Types for internationalisation scanning (#346).
 */

import type { GeneratedReview } from "./generated-review";

export type I18nIssueType =
	| "hardcoded_string"
	| "missing_key"
	| "unused_key"
	| "inconsistent_params"
	| "missing_plural"
	| "locale_file_mismatch"
	| "orphan_key"
	| "untranslated"
	| "rtl_side";

export type I18nSeverity = "error" | "warning" | "info";

export interface I18nIssue {
	issueType: I18nIssueType;
	severity: I18nSeverity;
	file: string;
	line: number;
	key: string;
	locale: string;
	message: string;
	suggestion: string;
	/** The hard-coded text, a copied reference text, or the style that does not mirror. */
	text?: string;
	/** For a hard-coded string: the key in the project's own style, its value and the call to paste. */
	proposedKey?: string;
	proposedValue?: string;
	snippet?: string;
	/** The proposed key already exists with the same text. */
	reused?: boolean;
	/** An orphan in a project that builds some keys at run time. */
	possibly?: boolean;
}

/** How far a locale is from the reference one. */
export interface I18nLocaleCompleteness {
	locale: string;
	/** Reference keys this locale needs (plural forms it does not use left out). */
	total: number;
	present: number;
	/** Present, but a sentence copied from the reference unchanged. */
	untranslated: number;
	missing: number;
	/** Translated keys out of `total`, in percent. */
	score: number;
	rtl: boolean;
}

export interface I18nReport {
	filesScanned: number;
	localesCompared: string[];
	issues: I18nIssue[];
	coverageByLocale: Record<string, number>;
	summary: string;
	referenceLocale?: string;
	completeness?: I18nLocaleCompleteness[];
	countsByType?: Record<string, number>;
	rtlLocales?: string[];
	/** Missing keys per locale in catalogs WorkPilot can write (JSON, ARB, RESX, Android, iOS, properties). */
	translatable?: Record<string, number>;
	catalogFormats?: string[];
}

export interface I18nTranslateRequest {
	projectPath: string;
	referenceLocale: string;
	/** Empty: every locale. */
	locales: string[];
}

export interface I18nTranslateOutcome {
	added: number;
	written: { file: string; locale: string; count: number }[];
	/** Answers dropped because they lost a placeholder or a tag, or never came. */
	rejected: number;
	/** Keys left for a next run (a run translates at most 400). */
	skipped: number;
	/** Whether any model answered. */
	answered: boolean;
	/** Catalogs with missing keys in a format WorkPilot does not write (YAML, XLIFF, gettext, PHP). */
	notWritable: string[];
	/** The review card the translations are on, or null when nothing was added. */
	review: GeneratedReview | null;
}
