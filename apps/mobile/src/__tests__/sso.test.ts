import * as AuthSession from "expo-auth-session";
import type { AuthConfig } from "../api/types";
import { endpointUrl, ssoIdToken, ssoProvider } from "../auth/sso";

const mockPrompt = jest.fn();
const mockRequests: Record<string, unknown>[] = [];

jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "nonce-2" }));
jest.mock("expo-auth-session", () => ({
	ResponseType: { Code: "code" },
	makeRedirectUri: jest.fn(() => "workpilot://auth"),
	exchangeCodeAsync: jest.fn(),
	AuthRequest: jest.fn().mockImplementation((options: Record<string, unknown>) => {
		mockRequests.push(options);
		return { codeVerifier: "verifier-2", promptAsync: mockPrompt };
	}),
}));

const exchange = AuthSession.exchangeCodeAsync as jest.Mock;

const CONFIG: AuthConfig = {
	local_enabled: true,
	entra_enabled: false,
	sso_enabled: true,
	sso_name: "Okta",
	sso_client_id: "0oa1b2c3",
	sso_scopes: "openid profile email",
	sso_authorization_endpoint: "https://acme.okta.com/oauth2/v1/authorize",
	sso_token_endpoint: "https://acme.okta.com/oauth2/v1/token",
};

describe("the server's OpenID Connect provider", () => {
	it("accepts https endpoints, and http only on this machine", () => {
		expect(endpointUrl("https://idp.example.com/authorize")).toBe("https://idp.example.com/authorize");
		expect(endpointUrl("http://localhost:8080/realms/x/auth")).toBe("http://localhost:8080/realms/x/auth");
		expect(endpointUrl("http://127.0.0.1/token")).toBe("http://127.0.0.1/token");
		for (const bad of [
			"http://idp.example.com/authorize",
			"http://192.168.1.4/authorize",
			"https://user:pw@idp.example.com/authorize",
			"https://idp.example.com/authorize#x",
			"javascript:alert(1)",
			"not a url",
			`https://idp.example.com/${"a".repeat(2000)}`,
			42,
		]) {
			expect(endpointUrl(bad)).toBeNull();
		}
	});

	it("reads the provider only when every part of it is usable", () => {
		expect(ssoProvider(CONFIG)).toEqual({
			authorizationEndpoint: CONFIG.sso_authorization_endpoint,
			tokenEndpoint: CONFIG.sso_token_endpoint,
			clientId: "0oa1b2c3",
			scopes: ["openid", "profile", "email"],
		});
		for (const change of [
			{ sso_enabled: false },
			{ sso_enabled: undefined },
			{ sso_authorization_endpoint: "http://evil.example.com/a" },
			{ sso_token_endpoint: null },
			{ sso_client_id: 7 },
			{ sso_client_id: "has space" },
			{ sso_scopes: "profile email" },
			{ sso_scopes: ["openid"] },
			{ sso_scopes: `openid ${Array.from({ length: 20 }, (_, i) => `s${i}`).join(" ")}` },
			{ sso_scopes: 'openid "quoted"' },
		]) {
			expect(ssoProvider({ ...CONFIG, ...change } as AuthConfig)).toBeNull();
		}
	});

	it("runs the code flow on the provider's endpoints with a nonce, and keeps a token that carries it", async () => {
		// "nonce-2" with a base64url payload that needs padding back.
		const token = `h.${btoa(JSON.stringify({ nonce: "nonce-2" })).replace(/=+$/, "")}.s`;
		mockPrompt.mockResolvedValueOnce({ type: "success", params: { code: "code-2" } });
		exchange.mockResolvedValueOnce({ idToken: token });
		await expect(ssoIdToken(CONFIG)).resolves.toBe(token);
		const discovery = {
			authorizationEndpoint: CONFIG.sso_authorization_endpoint,
			tokenEndpoint: CONFIG.sso_token_endpoint,
		};
		expect(mockRequests[0]).toEqual({
			clientId: "0oa1b2c3",
			redirectUri: "workpilot://auth",
			scopes: ["openid", "profile", "email"],
			responseType: "code",
			usePKCE: true,
			extraParams: { nonce: "nonce-2" },
		});
		expect(mockPrompt).toHaveBeenCalledWith(discovery);
		expect(exchange).toHaveBeenCalledWith(
			{ clientId: "0oa1b2c3", redirectUri: "workpilot://auth", code: "code-2", extraParams: { code_verifier: "verifier-2" } },
			discovery,
		);
	});

	it("opens nothing for a server without a usable provider, and names a failed sign-in", async () => {
		mockPrompt.mockClear();
		await expect(ssoIdToken({ ...CONFIG, sso_enabled: false })).rejects.toThrow("sso_disabled");
		expect(mockPrompt).not.toHaveBeenCalled();
		mockPrompt.mockResolvedValueOnce({ type: "error", error: null });
		await expect(ssoIdToken(CONFIG)).rejects.toThrow("sso_failed");
	});
});
