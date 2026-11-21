/**
 * The OpenID Connect sign-in of the main process: what it accepts from the
 * server, and the browser flow on a real loopback port. The browser is the
 * test, following the authorize URL to the redirect the provider would send.
 */
import { createHash } from "node:crypto";
import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
	acquireIdToken,
	endpointUrl,
	nonceOf,
	type OidcProvider,
	providerFromConfig,
} from "./oidc-pkce";

vi.mock("./open-external", () => ({ openExternalUrl: vi.fn() }));

const CONFIG = {
	sso_enabled: true,
	sso_authorization_endpoint: "https://login.example.test/authorize?tenant=x",
	sso_token_endpoint: "https://login.example.test/token",
	sso_client_id: "workpilot-desktop",
	sso_scopes: "openid profile email",
};

const PROVIDER = providerFromConfig(CONFIG) as OidcProvider;

function idTokenWith(claims: unknown): string {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

describe("what the server describes", () => {
	it("keeps https endpoints and http only on loopback", () => {
		expect(endpointUrl("https://idp.example.test/a?b=1")).toBe(
			"https://idp.example.test/a?b=1",
		);
		expect(endpointUrl("http://localhost:8080/auth")).toBe(
			"http://localhost:8080/auth",
		);
		expect(endpointUrl("http://[::1]/auth")).toBe("http://[::1]/auth");
		for (const bad of [
			"http://idp.example.test/auth",
			"https://user:pw@idp.example.test/",
			"https://idp.example.test/#x",
			"javascript:alert(1)",
			"not a url",
			`https://idp.example.test/${"a".repeat(2000)}`,
			42,
		]) {
			expect(endpointUrl(bad)).toBeNull();
		}
	});

	it("reads a provider only when every part is usable", () => {
		expect(PROVIDER).toEqual({
			authorizationEndpoint: CONFIG.sso_authorization_endpoint,
			tokenEndpoint: CONFIG.sso_token_endpoint,
			clientId: "workpilot-desktop",
			scopes: "openid profile email",
		});
		for (const bad of [
			null,
			"config",
			{ ...CONFIG, sso_enabled: false },
			{ ...CONFIG, sso_authorization_endpoint: "http://idp.example.test/a" },
			{ ...CONFIG, sso_token_endpoint: undefined },
			{ ...CONFIG, sso_client_id: 7 },
			{ ...CONFIG, sso_client_id: "has space" },
			{ ...CONFIG, sso_scopes: "profile email" },
			{ ...CONFIG, sso_scopes: undefined },
			{ ...CONFIG, sso_scopes: 'openid bad"scope' },
			{ ...CONFIG, sso_scopes: ["openid", ...Array(20).fill("x")].join(" ") },
		]) {
			expect(providerFromConfig(bad)).toBeNull();
		}
	});

	it("reads the nonce of an id_token, or nothing", () => {
		expect(nonceOf(idTokenWith({ nonce: "n-1" }))).toBe("n-1");
		expect(nonceOf(idTokenWith(null))).toBeUndefined();
		expect(nonceOf("only-one-part")).toBeUndefined();
		expect(nonceOf("a.not-json.c")).toBeUndefined();
	});
});

/** A GET on the loopback port, without `fetch` (which a test may stub). */
function get(url: URL): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		http
			.get(url, (res) => {
				let text = "";
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
			})
			.on("error", reject);
	});
}

type Answer = (authorize: URL) => Record<string, string> | "other-path";

/** A browser that follows the authorize URL to the provider's redirect. */
function browser(answer: Answer) {
	const seen: URL[] = [];
	const openBrowser = async (raw: string) => {
		const authorize = new URL(raw);
		seen.push(authorize);
		const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
		const reply = answer(authorize);
		if (reply === "other-path") {
			const missing = await get(new URL("/favicon.ico", redirect));
			expect(missing.status).toBe(404);
			return;
		}
		for (const [key, value] of Object.entries(reply)) {
			redirect.searchParams.set(key, value);
		}
		const page = await get(redirect);
		expect(page.text).toContain("Sign-in complete");
	};
	return { openBrowser, seen };
}

function tokenEndpoint(status: number, body: (form: URLSearchParams) => unknown) {
	const forms: URLSearchParams[] = [];
	const fetchToken = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const form = new URLSearchParams(String(init?.body));
		forms.push(form);
		const payload = body(form);
		return new Response(
			typeof payload === "string" ? payload : JSON.stringify(payload),
			{ status },
		);
	}) as unknown as typeof fetch;
	return { fetchToken, forms };
}

const answered: Answer = (authorize) => ({
	code: "the-code",
	state: authorize.searchParams.get("state") ?? "",
});

describe("the browser sign-in", () => {
	it("runs Authorization Code + PKCE and returns the id_token of this attempt", async () => {
		const { openBrowser, seen } = browser(answered);
		let nonce = "";
		const { fetchToken, forms } = tokenEndpoint(200, () => ({
			id_token: idTokenWith({ nonce }),
		}));
		const pending = acquireIdToken(PROVIDER, {
			openBrowser: async (url) => {
				nonce = new URL(url).searchParams.get("nonce") ?? "";
				await openBrowser(url);
			},
			fetchToken,
		});
		const token = await pending;
		expect(nonceOf(token)).toBe(nonce);

		const authorize = seen[0];
		expect(authorize.origin + authorize.pathname).toBe(
			"https://login.example.test/authorize",
		);
		const query = authorize.searchParams;
		expect(query.get("tenant")).toBe("x");
		expect(query.get("client_id")).toBe("workpilot-desktop");
		expect(query.get("response_type")).toBe("code");
		expect(query.get("scope")).toBe("openid profile email");
		expect(query.get("code_challenge_method")).toBe("S256");
		expect(query.get("redirect_uri")).toMatch(
			/^http:\/\/localhost:\d+\/callback$/,
		);

		const form = forms[0];
		expect(fetchToken).toHaveBeenCalledWith(
			"https://login.example.test/token",
			expect.objectContaining({ method: "POST" }),
		);
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("code")).toBe("the-code");
		expect(form.get("redirect_uri")).toBe(query.get("redirect_uri"));
		const challenge = createHash("sha256")
			.update(form.get("code_verifier") ?? "")
			.digest("base64url");
		expect(challenge).toBe(query.get("code_challenge"));
	});

	it("refuses an answer of another attempt, an error, or no code", async () => {
		const cases: [Answer, string][] = [
			[() => ({ code: "c", state: "another" }), "does not match this attempt"],
			[
				(a) => ({
					error: `access_denied${"x".repeat(100)}`,
					error_description: "<script>",
					state: a.searchParams.get("state") ?? "",
				}),
				`The identity provider refused: access_denied${"x".repeat(47)}`,
			],
			[(a) => ({ state: a.searchParams.get("state") ?? "" }), "returned no code"],
		];
		for (const [answer, message] of cases) {
			const { openBrowser } = browser(answer);
			const { fetchToken } = tokenEndpoint(200, () => ({}));
			const error = await acquireIdToken(PROVIDER, {
				openBrowser,
				fetchToken,
			}).catch((e: Error) => e);
			expect((error as Error).message).toContain(message);
			expect((error as Error).message).not.toContain("<script>");
			expect(fetchToken).not.toHaveBeenCalled();
		}
	});

	it("gives up when the browser never comes back", async () => {
		const { openBrowser } = browser(() => "other-path");
		await expect(
			acquireIdToken(PROVIDER, { openBrowser, timeoutMs: 200 }),
		).rejects.toThrow("Sign-in timed out");
	});

	it("fails when the browser cannot be opened", async () => {
		for (const thrown of [new Error("no browser"), "no handler"]) {
			await expect(
				acquireIdToken(PROVIDER, {
					openBrowser: () => Promise.reject(thrown),
				}),
			).rejects.toThrow(/no browser|no handler/);
		}
	});

	it("refuses a failed exchange and an id_token of another sign-in", async () => {
		const cases: [number, unknown, string][] = [
			[400, { error: "invalid_grant" }, "The token exchange failed (HTTP 400)"],
			[200, "not json", "The token exchange failed (HTTP 200)"],
			[200, { id_token: 3 }, "The token exchange failed (HTTP 200)"],
			[
				200,
				{ id_token: idTokenWith({ nonce: "replayed" }) },
				"was not issued for this sign-in",
			],
		];
		for (const [status, body, message] of cases) {
			const { openBrowser } = browser(answered);
			const { fetchToken } = tokenEndpoint(status, () => body);
			await expect(
				acquireIdToken(PROVIDER, { openBrowser, fetchToken }),
			).rejects.toThrow(message);
		}
	});

	it("opens the system browser through the guarded opener by default", async () => {
		const { openExternalUrl } = await import("./open-external");
		const opened = vi.mocked(openExternalUrl);
		opened.mockImplementation(async (url: string) => {
			await browser(answered).openBrowser(url);
		});
		const { fetchToken } = tokenEndpoint(500, () => ({}));
		vi.stubGlobal("fetch", fetchToken);
		try {
			await expect(acquireIdToken(PROVIDER)).rejects.toThrow("HTTP 500");
		} finally {
			vi.unstubAllGlobals();
		}
		expect(opened).toHaveBeenCalledTimes(1);
		expect(fetchToken).toHaveBeenCalledTimes(1);
	});
});
