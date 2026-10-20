/**
 * Onboarding Agent — Types for project onboarding guide generation.
 */

import type { OnboardingText } from "../../preload/api/modules/onboarding-agent-api";

export type OnboardingSection =
	| "overview"
	| "setup"
	| "architecture"
	| "conventions"
	| "workflows"
	| "testing"
	| "deployment"
	| "troubleshooting";

export interface OnboardingStep {
	section: OnboardingSection;
	title: string;
	content: string;
	commands: string[];
	estimatedMinutes: number;
	/** The title as an i18n descriptor; `title` is its English rendering. */
	titleI18n?: OnboardingText | null;
	/** `content` split into translatable lines. */
	lines?: OnboardingText[];
}

export interface OnboardingGuide {
	projectName: string;
	techStack: string[];
	steps: OnboardingStep[];
	totalEstimatedMinutes: number;
	generatedAt: string;
	summary: string;
	summaryI18n?: OnboardingText | null;
}
