/** The onboarding tour as a document to save outside the app (#349). */

export type OnboardingExportFormat = "markdown" | "html";

export interface OnboardingExportSection {
	heading: string;
	/** A paragraph before the lines: the chapter told by the model. */
	intro: string;
	lines: string[];
}

export interface OnboardingExportDocument {
	title: string;
	/** The language the document is written in (`en`, `fr`). */
	lang: string;
	generatedAt: string;
	sections: OnboardingExportSection[];
}

export interface OnboardingExportRequest {
	format: OnboardingExportFormat;
	document: OnboardingExportDocument;
}

export interface OnboardingExportOutcome {
	saved: boolean;
	path?: string;
}
