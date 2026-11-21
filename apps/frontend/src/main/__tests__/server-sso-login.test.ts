/**
 * The id_token of the server's OpenID Connect provider goes to
 * `/auth/sso/exchange`; the server's answer opens the session, or its refusal
 * is passed on as it is.
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
	getAuthState,
	loginWithSsoIdToken,
	setMode,
} from "../server-connection";

dir.path = mkdtempSync(path.join(tmpdir(), "wp-sso-"));
const USER = { id: "u1", email: "ada@example.com", display_name: "Ada", role: "member" };

afterEach(async () => {
	setMode("local");
	await flushPersistedState();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

afterAll(() => {
	rmSync(dir.path, { recursive: true, force: true });
});

describe("loginWithSsoIdToken", () => {
	it("exchanges the id_token and opens the session", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						access_token: "access",
						refresh_token: "refresh",
						expires_in: 900,
						user: USER,
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		setMode("server", "https://wp.example.test/");
		expect(await loginWithSsoIdToken("the-id-token")).toEqual({
			ok: true,
			user: USER,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://wp.example.test/auth/sso/exchange",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ id_token: "the-id-token" }),
			}),
		);
		expect(getAuthState().isAuthenticated).toBe(true);
	});

	it("passes the server's refusal on", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ detail: "Account is disabled" }), {
						status: 401,
					}),
			),
		);
		setMode("server", "https://wp.example.test");
		expect(await loginWithSsoIdToken("the-id-token")).toEqual({
			ok: false,
			error: "Account is disabled",
		});
		expect(getAuthState().isAuthenticated).toBe(false);
	});
});
