/**
 * The packaged app's Python backend runs plain scripts and cannot tell it is
 * packaged: the main process tells it, so both report errors on the same
 * condition.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
	app: { isPackaged: false, getVersion: () => "0.0.0" },
	ipcMain: { handle: vi.fn() },
}));

vi.mock("electron", () => electron);
vi.mock("@sentry/electron/main", () => ({ init: vi.fn() }));
vi.mock("../settings-utils", () => ({ readSettingsFile: () => ({}) }));

import { getSentryEnvForSubprocess } from "../sentry";

describe("getSentryEnvForSubprocess", () => {
	afterEach(() => {
		electron.app.isPackaged = false;
		vi.unstubAllEnvs();
	});

	it("marks the backend of a packaged app", () => {
		vi.stubEnv("SENTRY_DSN", "https://key@example.invalid/1");
		electron.app.isPackaged = true;

		expect(getSentryEnvForSubprocess().WORKPILOT_PACKAGED_APP).toBe("1");
	});

	it("does not mark a development backend", () => {
		vi.stubEnv("SENTRY_DSN", "https://key@example.invalid/1");

		expect(getSentryEnvForSubprocess()).not.toHaveProperty(
			"WORKPILOT_PACKAGED_APP",
		);
	});
});
