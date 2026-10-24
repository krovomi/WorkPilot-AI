import { describe, expect, it } from "vitest";
import type { ClaudeProfile } from "../../../shared/types";
import {
	maskClaudeProfile,
	maskClaudeProfileSettings,
	unmaskClaudeProfile,
} from "../renderer-view";

const MASK = "••••••••";
const TOKEN = "enc:sk-ant-oat01-test-0000"; // pragma: allowlist secret

const profile: ClaudeProfile = {
	id: "work",
	name: "Work",
	oauthToken: TOKEN,
	isDefault: false,
	createdAt: new Date(0),
};

describe("Claude profiles as the renderer sees them", () => {
	it("masks the token and leaves a profile without one alone", () => {
		expect(maskClaudeProfile(profile).oauthToken).toBe(MASK);
		expect(maskClaudeProfile({ ...profile, oauthToken: undefined }).oauthToken).toBeUndefined();
		expect(maskClaudeProfile(null)).toBeNull();
		const settings = maskClaudeProfileSettings({
			profiles: [profile],
			activeProfileId: "work",
		} as never);
		expect(JSON.stringify(settings)).not.toContain(TOKEN);
	});

	it("keeps the stored token when the mask comes back, takes a typed one", () => {
		expect(unmaskClaudeProfile({ ...profile, oauthToken: MASK }, profile).oauthToken).toBe(TOKEN);
		expect(unmaskClaudeProfile({ ...profile, oauthToken: MASK }, undefined).oauthToken).toBeUndefined();
		expect(unmaskClaudeProfile({ ...profile, oauthToken: "new" }, profile).oauthToken).toBe("new");
	});
});
