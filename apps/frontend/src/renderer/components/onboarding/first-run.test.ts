import { describe, expect, it } from "vitest";
import {
	type FirstRunState,
	isProfileSignedIn,
	shouldOpenOnboardingWizard,
} from "./first-run";

const FIRST_START: FirstRunState = {
	settingsHaveLoaded: true,
	serverSessionResolved: true,
	showServerLogin: false,
	onboardingCompleted: false,
	apiProfileCount: 0,
	claudeProfiles: [{ oauthToken: null }],
};

describe("shouldOpenOnboardingWizard", () => {
	it("opens on a first start once the connection choice is made", () => {
		expect(shouldOpenOnboardingWizard(FIRST_START)).toBe(true);
	});

	it("never opens over the local/server connection gate", () => {
		expect(
			shouldOpenOnboardingWizard({ ...FIRST_START, showServerLogin: true }),
		).toBe(false);
	});

	it("waits until the persisted server session has been read", () => {
		expect(
			shouldOpenOnboardingWizard({ ...FIRST_START, serverSessionResolved: false }),
		).toBe(false);
	});

	it("waits for settings, and stays shut once onboarding is done or auth exists", () => {
		expect(
			shouldOpenOnboardingWizard({ ...FIRST_START, settingsHaveLoaded: false }),
		).toBe(false);
		expect(
			shouldOpenOnboardingWizard({ ...FIRST_START, onboardingCompleted: true }),
		).toBe(false);
		expect(shouldOpenOnboardingWizard({ ...FIRST_START, apiProfileCount: 1 })).toBe(
			false,
		);
		expect(
			shouldOpenOnboardingWizard({
				...FIRST_START,
				claudeProfiles: [{ oauthToken: "token" }],
			}),
		).toBe(false);
	});
});

describe("isProfileSignedIn", () => {
	it("does not count the default profile's config dir as a sign-in", () => {
		// What a fresh install hands over: `~/.claude` set, nothing stored in it.
		expect(
			isProfileSignedIn({ oauthToken: undefined, isAuthenticated: false }),
		).toBe(false);
		expect(isProfileSignedIn({})).toBe(false);
	});

	it("counts a stored token or a login the main process verified", () => {
		expect(isProfileSignedIn({ oauthToken: "masked" })).toBe(true);
		expect(isProfileSignedIn({ isAuthenticated: true })).toBe(true);
	});

	it("keeps the wizard shut for a profile already signed in through the CLI", () => {
		expect(
			shouldOpenOnboardingWizard({
				...FIRST_START,
				claudeProfiles: [{ isAuthenticated: true }],
			}),
		).toBe(false);
	});
});
