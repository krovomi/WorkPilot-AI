import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./open-external", () => ({ openExternalUrl: vi.fn() }));

import { openExternalUrl } from "./open-external";
import {
	acquireEntraIdToken,
	authorizeUrl,
	checkEntraConfig,
	type EntraDeps,
	idTokenNonce,
} from "./entra-sign-in";

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONFIG = { entra_tenant_id: TENANT, entra_client_id: CLIENT };

function idToken(claims: Record<string, unknown>): string {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function jsonResponse(body: unknown, ok = true): Response {
	return { ok, json: async () => body } as Response;
}

/** A browser that follows the authorize URL straight back to the loopback. */
function browser(
	answer: (url: URL) => Record<string, string> | null,
	seen: URL[] = [],
): EntraDeps["openBrowser"] {
	return async (raw) => {
		const url = new URL(raw);
		seen.push(url);
		const query = answer(url);
		if (query === null) return;
		const back = new URL(url.searchParams.get("redirect_uri") as string);
		back.hostname = "127.0.0.1";
		for (const [key, value] of Object.entries(query)) {
			back.searchParams.set(key, value);
		}
		await get(back);
	};
}

/** A GET on the loopback that does not go through the global fetch. */
function get(url: URL): Promise<number> {
	return new Promise((resolve, reject) => {
		http
			.get(url, (res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			})
			.on("error", reject);
	});
}

const signedIn = (url: URL) => ({
	code: "the-code",
	state: url.searchParams.get("state") as string,
});

describe("checkEntraConfig", () => {
	it.each([
		TENANT,
		"contoso.onmicrosoft.com",
		"login.contoso.com",
		"organizations",
		"Common",
	])("takes the tenant %s", (tenant) => {
		expect(
			checkEntraConfig({ entra_tenant_id: ` ${tenant} `, entra_client_id: CLIENT })
				.entra_tenant_id,
		).toBe(tenant);
	});

	it.each([
		"",
		"contoso",
		"evil.example/../x",
		"a b.com",
		"x.com?y=1",
		"x.com#f",
		"x.com@y.com",
		"-x.com",
		`${"a".repeat(64)}.com`,
	])("refuses the tenant %j", (tenant) => {
		expect(() =>
			checkEntraConfig({ entra_tenant_id: tenant, entra_client_id: CLIENT }),
		).toThrow("not a valid tenant id");
	});

	it.each(["", "client", `${CLIENT}x`, "../aaaa"])(
		"refuses the client %j",
		(client) => {
			expect(() =>
				checkEntraConfig({ entra_tenant_id: TENANT, entra_client_id: client }),
			).toThrow("not a valid client id");
		},
	);

	it("refuses missing values", () => {
		expect(() =>
			checkEntraConfig({
				entra_tenant_id: undefined as unknown as string,
				entra_client_id: CLIENT,
			}),
		).toThrow("tenant");
		expect(() =>
			checkEntraConfig({
				entra_tenant_id: TENANT,
				entra_client_id: null as unknown as string,
			}),
		).toThrow("client");
	});
});

describe("idTokenNonce", () => {
	it("reads the nonce claim", () => {
		expect(idTokenNonce(idToken({ nonce: "n1" }))).toBe("n1");
	});

	it("answers null for a token without a usable nonce", () => {
		expect(idTokenNonce("only-one-part")).toBeNull();
		expect(idTokenNonce("a.!!!.c")).toBeNull();
		expect(idTokenNonce(idToken({ nonce: 3 }))).toBeNull();
		expect(idTokenNonce(idToken({}))).toBeNull();
	});
});

describe("authorizeUrl", () => {
	it("writes every parameter encoded, on the Microsoft authority", () => {
		const url = new URL(
			authorizeUrl(CONFIG, {
				redirectUri: "http://localhost:1/callback",
				state: "s&x=1",
				nonce: "n",
				challenge: "c",
			}),
		);
		expect(url.origin).toBe("https://login.microsoftonline.com");
		expect(url.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
		expect(url.searchParams.get("state")).toBe("s&x=1");
		expect(url.searchParams.get("x")).toBeNull();
		expect(url.searchParams.get("nonce")).toBe("n");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("client_id")).toBe(CLIENT);
	});
});

describe("acquireEntraIdToken", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exchanges the code with the global fetch by default", async () => {
		const seen: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					id_token: idToken({ nonce: seen[0].searchParams.get("nonce") }),
				}),
			),
		);
		const token = await acquireEntraIdToken(CONFIG, {
			openBrowser: browser(signedIn, seen),
		});
		expect(idTokenNonce(token)).toBe(seen[0].searchParams.get("nonce"));
	});

	it("signs in and returns the id_token that echoes the nonce", async () => {
		const seen: URL[] = [];
		const fakeFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("code")).toBe("the-code");
			expect(body.get("redirect_uri")).toBe(
				seen[0].searchParams.get("redirect_uri"),
			);
			return jsonResponse({
				id_token: idToken({ nonce: seen[0].searchParams.get("nonce") }),
			});
		});
		const token = await acquireEntraIdToken(CONFIG, {
			openBrowser: browser(signedIn, seen),
			fetch: fakeFetch as unknown as typeof fetch,
		});
		expect(idTokenNonce(token)).toBe(seen[0].searchParams.get("nonce"));
		expect(String(fakeFetch.mock.calls[0][0])).toBe(
			`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
		);
	});

	it("refuses an id_token issued for another request", async () => {
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: browser(signedIn),
				fetch: (async () =>
					jsonResponse({ id_token: idToken({ nonce: "other" }) })) as typeof fetch,
			}),
		).rejects.toThrow("does not match this request");
	});

	it("refuses a server configuration before opening anything", async () => {
		const openBrowser = vi.fn();
		await expect(
			acquireEntraIdToken(
				{ entra_tenant_id: "evil.example/x", entra_client_id: CLIENT },
				{ openBrowser },
			),
		).rejects.toThrow("tenant");
		expect(openBrowser).not.toHaveBeenCalled();
	});

	it("refuses a redirect carrying another state", async () => {
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: browser(() => ({ code: "c", state: "forged" })),
				fetch: vi.fn() as unknown as typeof fetch,
			}),
		).rejects.toThrow("State mismatch");
	});

	it("reports the provider's error, and a missing code", async () => {
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: browser((url) => ({
					state: url.searchParams.get("state") as string,
					error_description: "Denied",
				})),
			}),
		).rejects.toThrow("Denied");
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: browser((url) => ({
					state: url.searchParams.get("state") as string,
				})),
			}),
		).rejects.toThrow("No authorization code returned");
	});

	it("answers 404 to anything but GET /callback", async () => {
		let statuses: number[] = [];
		await acquireEntraIdToken(CONFIG, {
			openBrowser: async (raw) => {
				const url = new URL(raw);
				const back = new URL(url.searchParams.get("redirect_uri") as string);
				back.hostname = "127.0.0.1";
				const other = new URL("/elsewhere", back);
				statuses = [
					(await fetch(other)).status,
					(await fetch(back, { method: "POST" })).status,
				];
				back.searchParams.set("code", "c");
				back.searchParams.set("state", url.searchParams.get("state") as string);
				await fetch(back);
			},
			fetch: (async () => jsonResponse({}, false)) as unknown as typeof fetch,
		}).catch(() => undefined);
		expect(statuses).toEqual([404, 404]);
	});

	it("reports a failed token exchange", async () => {
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: browser(signedIn),
				fetch: (async () =>
					jsonResponse({ error_description: "Bad code" }, false)) as typeof fetch,
			}),
		).rejects.toThrow("Bad code");
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: browser(signedIn),
				fetch: (async () => jsonResponse({})) as typeof fetch,
			}),
		).rejects.toThrow("Token exchange failed");
	});

	it("gives up when the browser cannot be opened", async () => {
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: async () => {
					throw new Error("no browser");
				},
			}),
		).rejects.toThrow("no browser");
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: () => Promise.reject("plain"),
			}),
		).rejects.toThrow("plain");
	});

	it("times out when nobody comes back", async () => {
		await expect(
			acquireEntraIdToken(CONFIG, {
				openBrowser: browser(() => null),
				timeoutMs: 20,
			}),
		).rejects.toThrow("Login timed out");
	});

	it("opens the browser through openExternalUrl by default", async () => {
		vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error("blocked"));
		await expect(acquireEntraIdToken(CONFIG)).rejects.toThrow("blocked");
		const opened = new URL(vi.mocked(openExternalUrl).mock.calls[0][0]);
		expect(opened.hostname).toBe("login.microsoftonline.com");
	});
});
