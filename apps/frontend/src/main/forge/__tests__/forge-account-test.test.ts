/**
 * @vitest-environment node
 *
 * A saved account's connection test (forge-account-test.ts): the token goes
 * only to the account's own address, redirects are refused, and the renderer
 * learns a login or a short reason, never the forge's body.
 */

import { describe, expect, it, vi } from "vitest";
import type { ForgeAccountView } from "../../../shared/types/forge-accounts";
import { forgeAccountProbe, testForgeAccount } from "../forge-account-test";

const TOKEN = "pat-test-0000";

function account(over: Partial<ForgeAccountView>): ForgeAccountView {
	return { id: "a", forge: "github", label: "x", host: "https://github.com", hasToken: true, createdAt: "", ...over };
}

function answer(status: number, body: unknown): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("forgeAccountProbe", () => {
	it("asks each forge at the account's address", () => {
		expect(forgeAccountProbe(account({}), TOKEN)).toMatchObject({
			url: "https://api.github.com/user",
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(
			forgeAccountProbe(account({ forge: "gitlab", host: "https://gitlab.example.com" }), TOKEN),
		).toMatchObject({ url: "https://gitlab.example.com/api/v4/user", headers: { "PRIVATE-TOKEN": TOKEN } });
		const azure = forgeAccountProbe(account({ forge: "azure_devops", host: "https://dev.azure.com/contoso" }), TOKEN);
		expect(azure.url).toBe("https://dev.azure.com/contoso/_apis/connectionData");
		expect(azure.headers.Authorization).toBe(`Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`);
		const basic = forgeAccountProbe(account({ forge: "bitbucket", username: "me" }), TOKEN);
		expect(basic.url).toBe("https://api.bitbucket.org/2.0/user");
		expect(basic.headers.Authorization).toBe(`Basic ${Buffer.from(`me:${TOKEN}`).toString("base64")}`);
		expect(forgeAccountProbe(account({ forge: "bitbucket" }), TOKEN).headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("reads each forge's login", () => {
		expect(forgeAccountProbe(account({}), TOKEN).login({ login: "octo" })).toBe("octo");
		expect(forgeAccountProbe(account({ forge: "gitlab" }), TOKEN).login({ username: "gl" })).toBe("gl");
		const azure = forgeAccountProbe(account({ forge: "azure_devops" }), TOKEN);
		expect(azure.login({ authenticatedUser: { properties: { Account: { $value: "me@example.com" } } } })).toBe(
			"me@example.com",
		);
		expect(azure.login({ authenticatedUser: { providerDisplayName: "Me" } })).toBe("Me");
		expect(azure.login(null)).toBeUndefined();
		const bitbucket = forgeAccountProbe(account({ forge: "bitbucket" }), TOKEN);
		expect(bitbucket.login({ nickname: "nick" })).toBe("nick");
		expect(bitbucket.login({ username: " " })).toBeUndefined();
	});
});

describe("testForgeAccount", () => {
	it("needs a token", async () => {
		const fetchImpl = vi.fn();
		expect(await testForgeAccount(account({}), undefined, fetchImpl)).toEqual({ ok: false, error: "No token saved" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("answers the login, without following redirects", async () => {
		const fetchImpl = vi.fn(async () => answer(200, { login: "octo" }));
		expect(await testForgeAccount(account({}), TOKEN, fetchImpl)).toEqual({ ok: true, username: "octo" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.com/user",
			expect.objectContaining({ method: "GET", redirect: "error" }),
		);
	});

	it.each([
		[answer(401, { message: "Bad credentials" }), "Token refused (401)"],
		[answer(403, {}), "Token refused (403)"],
		[answer(500, "secret body"), "Unexpected answer (500)"],
		[answer(203, "<html>sign in</html>"), "Unexpected answer (203)"],
		[answer(200, "<html>sign in</html>"), "Token refused"],
		[answer(200, { other: 1 }), "Token refused"],
	])("gives a short reason for %#", async (response, error) => {
		const result = await testForgeAccount(account({}), TOKEN, async () => response);
		expect(result).toEqual({ ok: false, error });
	});

	it("says when the forge cannot be reached", async () => {
		const result = await testForgeAccount(account({}), TOKEN, async () => {
			throw new Error(`connect failed with ${TOKEN}`);
		});
		expect(result).toEqual({ ok: false, error: "The forge could not be reached" });
	});
});
