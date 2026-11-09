/**
 * The setup wizard's steps, in order, with the `onboarding` key of each
 * progress label. Kept apart so a test can check every key against the
 * locale files: `steps.claudeCode` had no entry and the progress bar printed
 * the raw key on a first start.
 */
export type WizardStepId =
	| "welcome"
	| "auth-choice"
	| "oauth"
	| "claude-code"
	| "devtools"
	| "privacy"
	| "completion";

export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStepId; labelKey: string }> =
	[
		{ id: "welcome", labelKey: "steps.welcome" },
		{ id: "auth-choice", labelKey: "steps.authChoice" },
		{ id: "oauth", labelKey: "steps.auth" },
		{ id: "claude-code", labelKey: "steps.cli" },
		{ id: "devtools", labelKey: "steps.devtools" },
		{ id: "privacy", labelKey: "steps.privacy" },
		{ id: "completion", labelKey: "steps.done" },
	];
