import * as AuthSession from "expo-auth-session";
import { ENTRA_SCOPES, entraIdToken, entraRedirectUri } from "../auth/entra";

const mockPrompt = jest.fn();
let mockCodeVerifier: string | undefined = "verifier-1";
const mockRequests: Record<string, unknown>[] = [];

jest.mock("expo-web-browser", () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock("expo-auth-session", () => ({
	ResponseType: { Code: "code" },
	Prompt: { SelectAccount: "select_account" },
	makeRedirectUri: jest.fn(() => "workpilot://auth"),
	fetchDiscoveryAsync: jest.fn(async (issuer: string) => ({ issuer })),
	exchangeCodeAsync: jest.fn(),
	AuthRequest: jest.fn().mockImplementation((options: Record<string, unknown>) => {
		mockRequests.push(options);
		return {
			get codeVerifier() {
				return mockCodeVerifier;
			},
			promptAsync: mockPrompt,
		};
	}),
}));

const config = {
	local_enabled: true,
	entra_enabled: true,
	entra_tenant_id: "contoso.onmicrosoft.com",
	entra_client_id: "client-1",
};
const exchange = AuthSession.exchangeCodeAsync as jest.Mock;

beforeEach(() => {
	mockPrompt.mockReset();
	exchange.mockReset();
	mockRequests.length = 0;
	mockCodeVerifier = "verifier-1";
});

describe("entraIdToken", () => {
	it("asks for the app's redirect on workpilot://auth", () => {
		expect(entraRedirectUri()).toBe("workpilot://auth");
		expect(AuthSession.makeRedirectUri).toHaveBeenCalledWith({ scheme: "workpilot", path: "auth" });
	});

	it("runs a PKCE code flow on the tenant's issuer and trades the code with the verifier", async () => {
		mockPrompt.mockResolvedValue({ type: "success", params: { code: "code-1" } });
		exchange.mockResolvedValue({ idToken: "id-token-1" });
		await expect(entraIdToken(config)).resolves.toBe("id-token-1");
		expect(AuthSession.fetchDiscoveryAsync).toHaveBeenCalledWith(
			"https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0",
		);
		expect(mockRequests[0]).toMatchObject({
			clientId: "client-1",
			redirectUri: "workpilot://auth",
			scopes: ENTRA_SCOPES,
			responseType: "code",
			usePKCE: true,
			prompt: "select_account",
		});
		expect(exchange).toHaveBeenCalledWith(
			{
				clientId: "client-1",
				redirectUri: "workpilot://auth",
				code: "code-1",
				extraParams: { code_verifier: "verifier-1" },
			},
			{ issuer: "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0" },
		);
	});

	it("sends no extra parameter without a code verifier", async () => {
		mockCodeVerifier = undefined;
		mockPrompt.mockResolvedValue({ type: "success", params: { code: "code-1" } });
		exchange.mockResolvedValue({ idToken: "id-token-1" });
		await entraIdToken(config);
		expect(exchange.mock.calls[0][0].extraParams).toBeUndefined();
	});

	it("returns null when the person closes Microsoft's page", async () => {
		mockPrompt.mockResolvedValue({ type: "dismiss" });
		await expect(entraIdToken(config)).resolves.toBeNull();
		expect(exchange).not.toHaveBeenCalled();
	});

	it("surfaces Microsoft's error description, or a generic failure", async () => {
		mockPrompt.mockResolvedValueOnce({ type: "error", error: { description: "AADSTS50020: user not in tenant" } });
		await expect(entraIdToken(config)).rejects.toThrow("AADSTS50020");
		mockPrompt.mockResolvedValueOnce({ type: "error", error: null });
		await expect(entraIdToken(config)).rejects.toThrow("entra_failed");
	});

	it("fails when Microsoft returns no id_token", async () => {
		mockPrompt.mockResolvedValue({ type: "success", params: { code: "code-1" } });
		exchange.mockResolvedValue({ accessToken: "a" });
		await expect(entraIdToken(config)).rejects.toThrow("entra_failed");
	});
});
