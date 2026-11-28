/**
 * The Claude profile a card or its project pins (pinned-claude-profile.ts):
 * used as it is when it exists and has a sign-in folder, otherwise the task
 * follows the active profile.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const profiles: Record<string, { id: string; name: string; configDir?: string }> = {};
const getProfileEnv = vi.fn((id: string) => ({ CLAUDE_CONFIG_DIR: `/profiles/${id}` }));
vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => ({
		getProfile: (id: string) => profiles[id],
		getProfileEnv: (id: string) => getProfileEnv(id),
	}),
}));
vi.mock("../../rate-limit-detector", () => ({
	ensureCleanProfileEnv: (env: Record<string, string>) => ({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "" }),
}));
const warn = vi.fn();
vi.mock("../../app-logger", () => ({ appLog: { warn: (...args: unknown[]) => warn(...args) } }));

import { pinnedClaudeProfile, pinnedClaudeProfileEnv } from "../pinned-claude-profile";

beforeEach(() => {
	for (const id of Object.keys(profiles)) delete profiles[id];
	warn.mockClear();
});

describe("pinnedClaudeProfile", () => {
	it("is the pinned profile when it has a sign-in folder", () => {
		profiles.work = { id: "work", name: "Work", configDir: "~/.claude-profiles/work" };
		expect(pinnedClaudeProfile({ accounts: { claude: "work" } })?.name).toBe("Work");
	});

	it("is undefined without a pin, and with a pin to a gone or folderless profile", () => {
		profiles.bare = { id: "bare", name: "Bare" };
		expect(pinnedClaudeProfile(undefined)).toBeUndefined();
		expect(pinnedClaudeProfile({ accounts: { openai: "x" } })).toBeUndefined();
		expect(pinnedClaudeProfile({ accounts: { claude: "gone" } })).toBeUndefined();
		expect(pinnedClaudeProfile({ accounts: { claude: "bare" } })).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(2);
	});
});

describe("pinnedClaudeProfileEnv", () => {
	it("is the pinned profile's environment, never a swap", () => {
		profiles.work = { id: "work", name: "Work", configDir: "~/.claude-profiles/work" };
		expect(pinnedClaudeProfileEnv({ accounts: { claude: "work" } })).toEqual({
			env: { CLAUDE_CONFIG_DIR: "/profiles/work", CLAUDE_CODE_OAUTH_TOKEN: "" },
			profileId: "work",
			profileName: "Work",
			wasSwapped: false,
		});
	});

	it("is undefined without a usable pin", () => {
		expect(pinnedClaudeProfileEnv({ accounts: { claude: "gone" } })).toBeUndefined();
		expect(getProfileEnv).not.toHaveBeenCalledWith("gone");
	});
});
