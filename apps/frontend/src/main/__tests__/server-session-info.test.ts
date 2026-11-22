/**
 * How the current server session was opened: the server's answer is kept
 * only in known shapes and bounded fields, and a refusal is never quoted at
 * length to the view.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	getServerUrl: vi.fn<() => string | null>(() => "https://wp.example.test"),
}));
vi.mock("../server-connection", () => mocks);

import { getServerSession, toSessionInfo } from "../server-session-info";

const SERVER = "https://wp.example.test";
const ANSWER = {
	user: { id: "u1", email: "ada@example.com", display_name: "Ada", role: "member" },
	login_id: "11111111-2222-4333-8444-555555555555",
	method: "oidc",
	provider_name: "Okta",
	issuer_host: "login.example.test",
	signed_in_at: "2026-11-22T08:30:00Z",
};

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.getServerUrl.mockReturnValue(SERVER);
});

describe("toSessionInfo", () => {
	it("keeps the display fields of the session", () => {
		expect(toSessionInfo(SERVER, ANSWER)).toEqual({
			serverUrl: SERVER,
			user: { email: "ada@example.com", displayName: "Ada", role: "member" },
			method: "oidc",
			providerName: "Okta",
			issuerHost: "login.example.test",
			signedInAt: "2026-11-22T08:30:00Z",
		});
	});

	it("drops what has no known shape", () => {
		const info = toSessionInfo(SERVER, {
			user: { email: " ada@example.com ", display_name: 7, role: "x".repeat(41) },
			method: "magic-link",
			provider_name: "Ok\nta",
			issuer_host: "evil.example/x",
			signed_in_at: "yesterday",
		});
		expect(info).toEqual({
			serverUrl: SERVER,
			user: { email: "ada@example.com", displayName: "ada@example.com", role: "" },
			method: null,
			providerName: null,
			issuerHost: null,
			signedInAt: null,
		});
	});

	it("is null without a person", () => {
		for (const raw of [null, "session", {}, { user: null }, { user: { email: "" } }]) {
			expect(toSessionInfo(SERVER, raw)).toBeNull();
		}
	});
});

describe("getServerSession", () => {
	it("reads the session of the current server", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: ANSWER });
		const result = await getServerSession();
		expect(result.success && result.data?.method).toBe("oidc");
		expect(mocks.authedFetch).toHaveBeenCalledWith("/auth/me/session", "GET");
	});

	it("needs a server", async () => {
		mocks.getServerUrl.mockReturnValue(null);
		expect(await getServerSession()).toEqual({
			success: false,
			error: "No server URL configured",
		});
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("reports a refusal briefly, and an unusable answer", async () => {
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "Not authenticated" });
		expect(await getServerSession()).toEqual({
			success: false,
			error: "Not authenticated",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: false, error: "x".repeat(301) });
		expect(await getServerSession()).toEqual({
			success: false,
			error: "Server unavailable",
		});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { user: {} } });
		expect(await getServerSession()).toEqual({
			success: false,
			error: "The server's answer is not usable",
		});
	});
});
