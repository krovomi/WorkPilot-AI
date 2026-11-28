/**
 * Microsoft Entra ID as a configuration of the OpenID Connect sign-in: the
 * ids the server gives are checked before they become Microsoft URLs, and the
 * browser flow is the generic one (`oidc-pkce.ts`), run here on a real
 * loopback port against the tenant's endpoints.
 */
import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("./open-external", () => ({ openExternalUrl: vi.fn() }));

import {
	checkEntraConfig,
	ENTRA_SCOPES,
	entraProvider,
	entraProviderFromConfig,
} from "./entra-sign-in";
import { acquireIdToken, nonceOf } from "./oidc-pkce";

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONFIG = { entra_tenant_id: TENANT, entra_client_id: CLIENT };
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;

function idToken(claims: Record<string, unknown>): string {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part(claims)}.sig`;
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

describe("entraProvider", () => {
	it("points the generic flow at the tenant's endpoints", () => {
		expect(entraProvider({ entra_tenant_id: ` ${TENANT} `, entra_client_id: CLIENT })).toEqual({
			authorizationEndpoint: `${AUTHORITY}/authorize`,
			tokenEndpoint: `${AUTHORITY}/token`,
			clientId: CLIENT,
			scopes: ENTRA_SCOPES,
		});
	});

	it("refuses ids without a valid shape before writing any URL", () => {
		expect(() =>
			entraProvider({ entra_tenant_id: "evil.example/x", entra_client_id: CLIENT }),
		).toThrow("tenant");
	});
});

describe("entraProviderFromConfig", () => {
	it("reads the provider the server describes", () => {
		expect(
			entraProviderFromConfig({ entra_enabled: true, ...CONFIG })?.tokenEndpoint,
		).toBe(`${AUTHORITY}/token`);
	});

	it("is null when the server offers no Entra sign-in", () => {
		for (const config of [null, "config", {}, { ...CONFIG, entra_enabled: false }]) {
			expect(entraProviderFromConfig(config)).toBeNull();
		}
	});

	it("throws when the server's ids have no valid shape", () => {
		expect(() =>
			entraProviderFromConfig({
				entra_enabled: true,
				entra_tenant_id: TENANT,
				entra_client_id: null,
			}),
		).toThrow("not a valid client id");
	});
});

describe("the Entra sign-in through the generic flow", () => {
	it("authorizes on the tenant, trades the code there, and keeps the nonce", async () => {
		const seen: URL[] = [];
		const fetchToken = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const form = new URLSearchParams(String(init?.body));
			expect(form.get("client_id")).toBe(CLIENT);
			expect(form.get("code")).toBe("the-code");
			expect(form.get("redirect_uri")).toBe(seen[0].searchParams.get("redirect_uri"));
			expect(form.get("code_verifier")).toBeTruthy();
			return new Response(
				JSON.stringify({ id_token: idToken({ nonce: seen[0].searchParams.get("nonce") }) }),
			);
		}) as unknown as typeof fetch;
		const token = await acquireIdToken(entraProvider(CONFIG), {
			openBrowser: async (raw) => {
				const url = new URL(raw);
				seen.push(url);
				const back = new URL(url.searchParams.get("redirect_uri") as string);
				back.searchParams.set("code", "the-code");
				back.searchParams.set("state", url.searchParams.get("state") as string);
				await get(back);
			},
			fetchToken,
		});
		expect(nonceOf(token)).toBe(seen[0].searchParams.get("nonce"));
		const authorize = seen[0];
		expect(authorize.origin + authorize.pathname).toBe(`${AUTHORITY}/authorize`);
		expect(authorize.searchParams.get("client_id")).toBe(CLIENT);
		expect(authorize.searchParams.get("scope")).toBe(ENTRA_SCOPES);
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("state")).toBeTruthy();
		expect(vi.mocked(fetchToken).mock.calls[0][0]).toBe(`${AUTHORITY}/token`);
	});

	it("refuses an id_token issued for another sign-in", async () => {
		await expect(
			acquireIdToken(entraProvider(CONFIG), {
				openBrowser: async (raw) => {
					const url = new URL(raw);
					const back = new URL(url.searchParams.get("redirect_uri") as string);
					back.searchParams.set("code", "c");
					back.searchParams.set("state", url.searchParams.get("state") as string);
					await get(back);
				},
				fetchToken: (async () =>
					new Response(JSON.stringify({ id_token: idToken({ nonce: "other" }) }))) as typeof fetch,
			}),
		).rejects.toThrow("was not issued for this sign-in");
	});
});
