/**
 * When the first-run wizard opens on its own.
 *
 * Only after settings are read from disk (an unread `onboardingCompleted`
 * looks false), with no auth configured yet (API profiles or a Claude OAuth
 * token mean the user has been through setup), and once the connection gate
 * is settled: the persisted server session has been read and the local/server
 * choice is not on screen. Opened earlier, the wizard's full-screen dialog
 * covered that choice on a first start (flaky first-run E2E on develop, #588).
 */
export interface FirstRunState {
	settingsHaveLoaded: boolean;
	serverSessionResolved: boolean;
	showServerLogin: boolean;
	onboardingCompleted: boolean | undefined;
	apiProfileCount: number;
	claudeProfiles: ReadonlyArray<{ oauthToken?: string | null }>;
}

export function shouldOpenOnboardingWizard(state: FirstRunState): boolean {
	const hasAnyAuth =
		state.apiProfileCount > 0 || state.claudeProfiles.some((p) => p.oauthToken);
	return (
		state.settingsHaveLoaded &&
		state.serverSessionResolved &&
		!state.showServerLogin &&
		state.onboardingCompleted === false &&
		!hasAnyAuth
	);
}
