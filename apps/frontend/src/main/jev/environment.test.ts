import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), read: vi.fn() }));
vi.mock("../settings-utils", () => ({ readSettingsFile: mocks.settings }));
vi.mock("./service", () => ({ getJevService: () => ({ read: mocks.read }) }));
import { buildJevEnvironment } from "./environment";

beforeEach(() => {
	mocks.settings.mockReturnValue({ jev: { enabled: true } });
	mocks.read.mockReturnValue("new-key");
});
it("removes inherited credentials after deletion", () => {
	mocks.read.mockReturnValue(undefined);
	const env = buildJevEnvironment(
		{ TYPESAFE_API_KEY: "stale", PATH: "keep" },
		"feature-build",
	);
	expect(env.TYPESAFE_API_KEY).toBeUndefined();
	expect(env.PATH).toBe("keep");
});
it("does not expose the key to unrelated workers", () => {
	const env = buildJevEnvironment({ TYPESAFE_API_KEY: "stale" });
	expect(env.TYPESAFE_API_KEY).toBeUndefined();
});
it("honors workflow modes above the global default", () => {
	mocks.settings.mockReturnValue({
		jev: {
			enabled: false,
			workflows: { "github-review": "enabled", "gitlab-review": "bypass" },
		},
	});
	expect(buildJevEnvironment({}, "github-review").TYPESAFE_API_KEY).toBe(
		"new-key",
	);
	expect(
		buildJevEnvironment({}, "gitlab-review").TYPESAFE_API_KEY,
	).toBeUndefined();
});
it("does not mutate the parent and overrides stale settings", () => {
	const base = { WORKPILOT_JEV_ENABLED: "0", TYPESAFE_API_KEY: "old" };
	expect(buildJevEnvironment(base, "feature-build").WORKPILOT_JEV_ENABLED).toBe(
		"1",
	);
	expect(base.TYPESAFE_API_KEY).toBe("old");
});
it("treats invalid settings as a bypass without reading the key", () => {
	mocks.read.mockClear();
	mocks.settings.mockReturnValue({ jev: { enabled: "false" } });
	expect(
		buildJevEnvironment({}, "feature-build").TYPESAFE_API_KEY,
	).toBeUndefined();
	expect(mocks.read).not.toHaveBeenCalled();
});
