import { describe, expect, it, vi } from "vitest";

// credential-manager pulls in electron transitively (profile-manager needs
// `app.getPath`). The predicate under test is pure, so stub the file-I/O
// modules rather than booting an Electron environment.
vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../utils/profile-manager", () => ({
	loadProfilesFile: vi.fn(),
	saveProfilesFile: vi.fn(),
}));
vi.mock("../settings-utils", () => ({
	readSettingsFile: vi.fn(),
	writeSettingsFile: vi.fn(),
}));

import { isPlaceholderApiKey } from "./credential-manager";

describe("isPlaceholderApiKey", () => {
	it.each([
		["", "empty"],
		["   ", "whitespace only"],
		["sk-ant-placeholder", "contains placeholder"],
		["test-abcdef", "test- prefix"],
		["sk-ant-test01-xxxxxxxxxxxxxxxxxxxxxxxxxxx", "sk-ant-test prefix"],
	])("treats %j as a placeholder (%s)", (key) => {
		expect(isPlaceholderApiKey(key)).toBe(true);
	});

	it.each([undefined, null])("treats %j as a placeholder", (key) => {
		expect(isPlaceholderApiKey(key)).toBe(true);
	});

	it("keeps real long provider keys", () => {
		expect(isPlaceholderApiKey(`sk-ant-api03-${"a".repeat(60)}`)).toBe(false);
		expect(isPlaceholderApiKey(`sk-proj-${"b".repeat(40)}`)).toBe(false);
	});

	// The regression this predicate exists for: WorkPilot advertises support for
	// "any OpenAI-compatible endpoint", and local runtimes are conventionally
	// configured with short throwaway keys. The previous `length < 20` rule
	// classified all of these as fake and deleted the profiles on startup.
	it.each(["ollama", "sk-local", "lm-studio", "dummy", "none", "EMPTY"])(
		"keeps short local-runtime key %j",
		(key) => {
			expect(isPlaceholderApiKey(key)).toBe(false);
		},
	);
});
