/**
 * A forgotten server password: the renderer's arguments are checked before
 * any request leaves, the token is taken out of a pasted link, and a refusal
 * says the server's reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../server-connection", () => ({ authedFetch: mocks.authedFetch }));

import {
	confirmPasswordReset,
	issuePasswordReset,
	lookupPasswordReset,
	requestPasswordReset,
	serverBase,
	tokenOf,
} from "../server-password-reset";

const TOKEN = "A".repeat(43);
const LINK = `https://wp.example.test/reset-password?token=${TOKEN}`;
const PASSWORD = "a-brand-new-passphrase-42"; // pragma: allowlist secret
const fetchMock = vi.fn();

function answer(status: number, body: unknown) {
	return {
		ok: status < 300,
		status,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("serverBase", () => {
	it("keeps http and https addresses without a trailing slash", () => {
		expect(serverBase(" https://wp.example.test/ ")).toBe("https://wp.example.test");
		expect(serverBase("http://192.168.1.20:8080/base//")).toBe(
			"http://192.168.1.20:8080/base",
		);
	});

	it("refuses anything else", () => {
		for (const value of [
			undefined,
			42,
			"",
			"not a url",
			"file:///etc/passwd",
			"https://user:pw@wp.example.test", // pragma: allowlist secret
			"https://wp.example.test/?x=1",
			"https://wp.example.test/#frag",
			`https://${"a".repeat(2001)}`,
		]) {
			expect(serverBase(value)).toBeNull();
		}
	});
});

describe("tokenOf", () => {
	it("reads a pasted link or a bare token", () => {
		expect(tokenOf(LINK)).toBe(TOKEN);
		expect(tokenOf(`  ${TOKEN}\n`)).toBe(TOKEN);
	});

	it("refuses what is not a token", () => {
		for (const value of [null, 7, "short", "has spaces in it here", "x".repeat(201)]) {
			expect(tokenOf(value)).toBeNull();
		}
		expect(tokenOf("https://wp.example.test/reset-password?token=bad token")).toBeNull();
	});
});

describe("requests", () => {
	it("asks for a link with the trimmed address", async () => {
		fetchMock.mockResolvedValue(answer(202, { requested: true }));
		expect(await requestPasswordReset("https://wp.example.test/", " a@example.test ")).toEqual({
			ok: true,
			data: { requested: true },
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://wp.example.test/auth/password-reset/request");
		expect(JSON.parse(init.body)).toEqual({ email: "a@example.test" });
	});

	it("reads a link and sets the password with its token only", async () => {
		fetchMock
			.mockResolvedValueOnce(answer(200, { email: "a@example.test" }))
			.mockResolvedValueOnce(answer(200, { reset: true }));
		expect(await lookupPasswordReset("https://wp.example.test", LINK)).toEqual({
			ok: true,
			data: { email: "a@example.test" },
		});
		expect(await confirmPasswordReset("https://wp.example.test", LINK, PASSWORD)).toEqual({
			ok: true,
			data: { reset: true },
		});
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: TOKEN });
		expect(fetchMock.mock.calls[1][0]).toBe(
			"https://wp.example.test/auth/password-reset/confirm",
		);
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			token: TOKEN,
			new_password: PASSWORD,
		});
	});

	it("gives the server's reason, or the status when it gave none", async () => {
		fetchMock
			.mockResolvedValueOnce(answer(404, { detail: "This reset link is invalid or has expired" }))
			.mockResolvedValueOnce(answer(500, "<html>"))
			.mockResolvedValueOnce(answer(400, { detail: { nested: true } }))
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockRejectedValueOnce("down");
		const base = "https://wp.example.test";
		expect(await lookupPasswordReset(base, LINK)).toEqual({
			ok: false,
			error: "This reset link is invalid or has expired",
		});
		expect(await lookupPasswordReset(base, LINK)).toEqual({ ok: false, error: "HTTP 500" });
		expect(await lookupPasswordReset(base, LINK)).toEqual({ ok: false, error: "HTTP 400" });
		expect(await lookupPasswordReset(base, LINK)).toEqual({ ok: false, error: "ECONNREFUSED" });
		expect(await lookupPasswordReset(base, LINK)).toEqual({ ok: false, error: "down" });
	});

	it("refuses bad arguments without asking the server", async () => {
		const base = "https://wp.example.test";
		expect((await requestPasswordReset("ftp://x", "a@example.test")).ok).toBe(false);
		expect((await requestPasswordReset(base, "no-at-sign")).ok).toBe(false);
		expect((await requestPasswordReset(base, 3)).ok).toBe(false);
		expect((await requestPasswordReset(base, `${"a".repeat(320)}@x`)).ok).toBe(false);
		expect((await lookupPasswordReset("nope", LINK)).ok).toBe(false);
		expect((await lookupPasswordReset(base, "short")).ok).toBe(false);
		expect((await confirmPasswordReset("nope", LINK, PASSWORD)).ok).toBe(false);
		expect((await confirmPasswordReset(base, "short", PASSWORD)).ok).toBe(false);
		expect((await confirmPasswordReset(base, LINK, "too-short")).ok).toBe(false);
		expect((await confirmPasswordReset(base, LINK, "x".repeat(1025))).ok).toBe(false);
		expect((await confirmPasswordReset(base, LINK, 12)).ok).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("issuePasswordReset", () => {
	it("asks the connected server for an account's link", async () => {
		const issued = {
			email: "a@example.test",
			expires_at: "2026-11-22T12:00:00Z",
			email_sent: false,
			reset_link: LINK,
		};
		mocks.authedFetch.mockResolvedValue({ ok: true, data: issued });
		const id = "0b6a1c1e-4b1f-4c5e-9a39-2a8c2f7b9d11";
		expect(await issuePasswordReset(id)).toEqual({ ok: true, data: issued });
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			`/admin/users/${id}/password-reset`,
			"POST",
		);
	});

	it("refuses an id that is not one", async () => {
		for (const value of [undefined, "", "../orgs", "a/b", "x".repeat(65)]) {
			expect((await issuePasswordReset(value)).ok).toBe(false);
		}
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});
});
