import { ApiError, errorMessage, ServerClient } from "../api/client";
import type { TokenResponse } from "../api/types";

const user = { id: "u1", email: "ada@x.io", display_name: "Ada", role: "member" };

function tokens(n: number): TokenResponse {
	return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900, user };
}

function json(status: number, body: unknown): Response {
	return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const impl = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} };
		calls.push(call);
		return handler(call);
	});
	return { calls, impl: impl as unknown as typeof fetch };
}

const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

describe("ServerClient", () => {
	it("signs in, then sends the token and the organization on each request", async () => {
		const { calls, impl } = fakeFetch(({ url }) => {
			if (url.endsWith("/auth/login")) return json(200, tokens(1));
			return json(200, [{ id: "p1" }]);
		});
		const onTokens = jest.fn();
		const client = new ServerClient({ baseUrl: "https://x.io/", fetchImpl: impl, onTokens });
		await client.login("ada@x.io", "secret");
		client.setOrg("org-a");
		await client.request("GET", "/projects");

		expect(calls[0].url).toBe("https://x.io/auth/login");
		expect(header(calls[0], "Authorization")).toBeUndefined();
		expect(header(calls[1], "Authorization")).toBe("Bearer access-1");
		expect(header(calls[1], "X-WorkPilot-Org")).toBe("org-a");
		expect(onTokens).toHaveBeenCalledWith(tokens(1));
	});

	it("refreshes an expired token once for concurrent requests, then retries", async () => {
		let refreshes = 0;
		const { calls, impl } = fakeFetch(({ url, init }) => {
			if (url.endsWith("/auth/refresh")) {
				refreshes += 1;
				return json(200, tokens(2));
			}
			const auth = header({ url, init }, "Authorization");
			return auth === "Bearer access-2" ? json(200, { ok: true }) : json(401, { detail: "expired" });
		});
		const client = new ServerClient({ baseUrl: "https://x.io", refreshToken: "refresh-1", fetchImpl: impl });
		// No access token yet: the first request refreshes, the others share it.
		const results = await Promise.all([
			client.request("GET", "/a"),
			client.request("GET", "/b"),
			client.request("GET", "/c"),
		]);
		expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
		expect(refreshes).toBe(1);
		const refreshCall = calls.find((c) => c.url.endsWith("/auth/refresh"));
		expect(JSON.parse(String(refreshCall?.init.body))).toEqual({ refresh_token: "refresh-1" });
	});

	it("signs out when the server refuses the refresh token", async () => {
		const { impl } = fakeFetch(() => json(401, { detail: "revoked" }));
		const onSignedOut = jest.fn();
		const client = new ServerClient({ baseUrl: "https://x.io", refreshToken: "old", fetchImpl: impl, onSignedOut });
		await expect(client.request("GET", "/projects")).rejects.toMatchObject({ status: 401 });
		expect(onSignedOut).toHaveBeenCalledTimes(1);
		expect(client.hasSession).toBe(false);
	});

	it("keeps the session when the network is down", async () => {
		const impl = jest.fn(async () => {
			throw new TypeError("Network request failed");
		}) as unknown as typeof fetch;
		const onSignedOut = jest.fn();
		const client = new ServerClient({ baseUrl: "https://x.io", refreshToken: "keep", fetchImpl: impl, onSignedOut });
		await expect(client.refresh()).rejects.toEqual(new ApiError(0, "network"));
		expect(client.hasSession).toBe(true);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it("surfaces the server's detail, cut short", async () => {
		const { impl } = fakeFetch(({ url }) =>
			url.endsWith("/auth/refresh") ? json(200, tokens(1)) : json(409, { detail: "Spec already claimed by Bob" }),
		);
		const client = new ServerClient({ baseUrl: "https://x.io", refreshToken: "r", fetchImpl: impl });
		await expect(client.request("POST", "/x", {})).rejects.toEqual(new ApiError(409, "Spec already claimed by Bob"));
		expect(errorMessage(500, "<html>")).toBe("HTTP 500");
		expect(errorMessage(400, JSON.stringify({ detail: "y".repeat(1000) }))).toHaveLength(300);
	});

	it("switches organization by adopting the new pair", async () => {
		const { calls, impl } = fakeFetch(({ url }) =>
			url.endsWith("/auth/refresh") ? json(200, tokens(1)) : json(200, tokens(3)),
		);
		const client = new ServerClient({ baseUrl: "https://x.io", refreshToken: "r", fetchImpl: impl });
		await client.switchOrg("org-b");
		expect(client.activeOrgId).toBe("org-b");
		expect(client.currentAccessToken).toBe("access-3");
		expect(JSON.parse(String(calls[1].init.body))).toEqual({ org_id: "org-b" });
	});

	it("revokes the refresh token on sign-out even if the server is unreachable", async () => {
		const impl = jest.fn(async () => {
			throw new TypeError("offline");
		}) as unknown as typeof fetch;
		const onSignedOut = jest.fn();
		const client = new ServerClient({ baseUrl: "https://x.io", refreshToken: "r", fetchImpl: impl, onSignedOut });
		await client.logout();
		expect(client.hasSession).toBe(false);
		expect(onSignedOut).toHaveBeenCalled();
	});
});
