/**
 * The connection gate is decided before anything else may open over it.
 *
 * App.tsx opens the first-run wizard only once `sessionResolved` is true and
 * the gate is closed. Were the flag set before the persisted session is read,
 * the wizard's full-screen dialog could open first and cover the local/server
 * choice of a first start (the flaky first-run E2E on develop, #588).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServerSessionStore } from "../server-session-store";

const LOCAL_UNCONFIGURED = {
	mode: "local" as const,
	serverUrl: null,
	user: null,
	isAuthenticated: false,
	configured: false,
};

function setBridge(restore: () => Promise<unknown>): void {
	// The store reads `window.electronAPI`; this suite runs in node.
	vi.stubGlobal("window", {
		electronAPI: { serverAuth: { restore, onStateChanged: vi.fn() } },
	});
}

describe("server session store", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	beforeEach(() => {
		useServerSessionStore.setState({
			isLoginScreenOpen: false,
			initialized: false,
			sessionResolved: false,
		});
	});

	it("is not resolved while the persisted session is still being read", async () => {
		let finish: (value: unknown) => void = () => undefined;
		setBridge(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = useServerSessionStore.getState().initialize();
		expect(useServerSessionStore.getState().sessionResolved).toBe(false);
		expect(useServerSessionStore.getState().isLoginScreenOpen).toBe(false);

		finish(LOCAL_UNCONFIGURED);
		await pending;
		expect(useServerSessionStore.getState().isLoginScreenOpen).toBe(true);
		expect(useServerSessionStore.getState().sessionResolved).toBe(true);
	});

	it("resolves even when the session cannot be read", async () => {
		setBridge(() => Promise.reject(new Error("no bridge")));
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await useServerSessionStore.getState().initialize();
		expect(useServerSessionStore.getState().sessionResolved).toBe(true);
		spy.mockRestore();
	});
});
