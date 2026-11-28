/**
 * `onServerSignedIn`: told when a session starts (a sign-in, or the session
 * restored at launch), not at each token refresh. The launch dialog uses it to
 * add the runs the team server stopped once the session is there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const dir = vi.hoisted(() => ({ path: "" }));
vi.mock("electron", () => ({
	app: { getPath: () => dir.path },
	safeStorage: { isAsyncEncryptionAvailable: async () => false },
}));

import {
	flushPersistedState,
	loginLocal,
	onServerSignedIn,
	refreshSession,
	setMode,
} from "../server-connection";

dir.path = mkdtempSync(path.join(tmpdir(), "wp-sign-in-"));
const USER = { id: "u1", email: "ada@example.com", display_name: "Ada", role: "member" };

function tokens() {
	return new Response(
		JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 900, user: USER }),
		{ status: 200 },
	);
}

afterEach(async () => {
	setMode("local");
	await flushPersistedState();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

afterAll(() => {
	rmSync(dir.path, { recursive: true, force: true });
});

describe("onServerSignedIn", () => {
	it("hears a sign-in once, not the refreshes after it, until it unsubscribes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.stubGlobal("fetch", vi.fn(async () => tokens()));
		const heard = vi.fn();
		const failing = vi.fn(() => {
			throw new Error("listener bug");
		});
		const stop = onServerSignedIn(heard);
		const stopFailing = onServerSignedIn(failing);
		setMode("server", "https://wp.example.test");

		await loginLocal("ada@example.com", "pw");
		expect(heard).toHaveBeenCalledTimes(1);
		// A listener that throws neither stops the sign-in nor the others.
		expect(failing).toHaveBeenCalledTimes(1);

		expect(await refreshSession()).toBe(true);
		expect(heard).toHaveBeenCalledTimes(1);

		setMode("local");
		setMode("server", "https://wp.example.test");
		stop();
		stopFailing();
		await loginLocal("ada@example.com", "pw");
		expect(heard).toHaveBeenCalledTimes(1);
	});
});
