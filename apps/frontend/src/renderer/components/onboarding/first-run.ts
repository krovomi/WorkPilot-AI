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
	claudeProfiles: ReadonlyArray<SignInState>;
}

/** What a Claude profile, as the main process hands it over, says about its sign-in. */
export interface SignInState {
	oauthToken?: string | null;
	/** Computed in the main process from the token or the config dir's stored login. */
	isAuthenticated?: boolean;
}

/**
 * Whether a Claude profile can run a build. Only what the main process
 * verified counts: the default profile always carries a `configDir`
 * (`~/.claude`), which exists before anyone signs in.
 */
export function isProfileSignedIn(profile: SignInState): boolean {
	return Boolean(profile.oauthToken) || profile.isAuthenticated === true;
}

export function shouldOpenOnboardingWizard(state: FirstRunState): boolean {
	const hasAnyAuth =
		state.apiProfileCount > 0 || state.claudeProfiles.some(isProfileSignedIn);
	return (
		state.settingsHaveLoaded &&
		state.serverSessionResolved &&
		!state.showServerLogin &&
		state.onboardingCompleted === false &&
		!hasAnyAuth
	);
}
