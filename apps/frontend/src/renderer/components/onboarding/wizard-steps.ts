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
	| "providers"
	| "claude-code"
	| "devtools"
	| "privacy"
	| "completion";

export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStepId; labelKey: string }> =
	[
		{ id: "welcome", labelKey: "steps.welcome" },
		{ id: "auth-choice", labelKey: "steps.authChoice" },
		{ id: "oauth", labelKey: "steps.auth" },
		{ id: "providers", labelKey: "steps.providers" },
		{ id: "claude-code", labelKey: "steps.cli" },
		{ id: "devtools", labelKey: "steps.devtools" },
		{ id: "privacy", labelKey: "steps.privacy" },
		{ id: "completion", labelKey: "steps.done" },
	];

/**
 * What the user picked on the « Choose your AI » step:
 * - `undecided`: not chosen yet, the Claude path is shown as the default;
 * - `claude`: sign in with a Claude account, then the Claude Code CLI;
 * - `api-key`: an Anthropic-compatible API key, saved as a profile;
 * - `other`: any other provider (Codex, Copilot, Gemini, OpenCode, Ollama…),
 *   configured in the same panel as Settings → Accounts;
 * - `skipped`: nothing now, configured later.
 */
export type WizardPath = "undecided" | "claude" | "api-key" | "other" | "skipped";

const STEPS_BY_PATH: Readonly<Record<WizardPath, readonly WizardStepId[]>> = {
	undecided: ["oauth", "claude-code"],
	claude: ["oauth", "claude-code"],
	// A key saved as a profile replaces the Claude sign-in, not the rest of
	// the setup: the API-key path used to jump straight to the last screen.
	"api-key": [],
	other: ["providers"],
	skipped: ["claude-code"],
};

/** The steps the user walks through on a path, in order. */
export function stepsForPath(path: WizardPath): ReadonlyArray<{
	id: WizardStepId;
	labelKey: string;
}> {
	const shown = new Set<WizardStepId>([
		"welcome",
		"auth-choice",
		...STEPS_BY_PATH[path],
		"devtools",
		"privacy",
		"completion",
	]);
	return WIZARD_STEPS.filter((step) => shown.has(step.id));
}

/** The step after (or before) `current` on `path`, or `current` at an end. */
export function neighbourStep(
	path: WizardPath,
	current: WizardStepId,
	direction: 1 | -1,
): WizardStepId {
	const steps = stepsForPath(path);
	const index = steps.findIndex((step) => step.id === current);
	if (index < 0) return current;
	const next = steps[index + direction];
	return next ? next.id : current;
}
