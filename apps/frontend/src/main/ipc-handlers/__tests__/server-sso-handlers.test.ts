/**
 * The OpenID Connect sign-in channel: the server URL from the renderer is
 * checked in main, the provider is the one the server describes, and only an
 * id_token of this sign-in goes to the server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	sent: [] as unknown[][],
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));

const connection = vi.hoisted(() => ({
	getAuthState: vi.fn(() => ({ mode: "server", isAuthenticated: true })),
	getServerAuthConfig: vi.fn(),
	loginWithSsoIdToken: vi.fn(),
	setMode: vi.fn(),
}));
vi.mock("../../server-connection", () => connection);

const pkce = vi.hoisted(() => ({ acquireIdToken: vi.fn() }));
vi.mock("../../oidc-pkce", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../oidc-pkce")>()),
	acquireIdToken: pkce.acquireIdToken,
}));

import {
	loginSso,
	registerServerSsoHandlers,
	serverUrlFrom,
} from "../server-sso-handlers";

const CONFIG = {
	local_enabled: true,
	entra_enabled: false,
	entra_tenant_id: null,
	entra_client_id: null,
	sso_enabled: true,
	sso_name: "Okta",
	sso_client_id: "workpilot-desktop",
	sso_scopes: "openid profile email",
	sso_authorization_endpoint: "https://idp.example.test/authorize",
	sso_token_endpoint: "https://idp.example.test/token",
};
const USER = { id: "u1", email: "ada@example.com", display_name: "Ada", role: "member" };

beforeEach(() => {
	vi.clearAllMocks();
	state.sent.length = 0;
	connection.getServerAuthConfig.mockResolvedValue({ ok: true, data: CONFIG });
	connection.loginWithSsoIdToken.mockResolvedValue({ ok: true, user: USER });
	pkce.acquireIdToken.mockResolvedValue("the-id-token");
});

describe("the server URL", () => {
	it("is an http(s) URL without credentials", () => {
		expect(serverUrlFrom(" https://wp.example.test/// ")).toBe(
			"https://wp.example.test",
		);
		expect(serverUrlFrom("http://10.0.0.5:9000")).toBe("http://10.0.0.5:9000");
		for (const bad of [
			undefined,
			42,
			"  ",
			"not a url",
			"file:///etc/passwd",
			"https://user:pw@wp.example.test",
			`https://wp.example.test/${"a".repeat(2000)}`,
		]) {
			expect(serverUrlFrom(bad)).toBeNull();
		}
	});
});

describe("loginSso", () => {
	it("signs in with the provider the server describes", async () => {
		const result = await loginSso("https://wp.example.test/");
		expect(result).toEqual({ ok: true, user: USER });
		expect(connection.getServerAuthConfig).toHaveBeenCalledWith(
			"https://wp.example.test",
		);
		expect(connection.setMode).toHaveBeenCalledWith(
			"server",
			"https://wp.example.test",
		);
		expect(pkce.acquireIdToken).toHaveBeenCalledWith(
			{
				authorizationEndpoint: CONFIG.sso_authorization_endpoint,
				tokenEndpoint: CONFIG.sso_token_endpoint,
				clientId: "workpilot-desktop",
				scopes: "openid profile email",
			},
			{},
		);
		expect(connection.loginWithSsoIdToken).toHaveBeenCalledWith("the-id-token");
	});

	it("refuses a bad URL before any request", async () => {
		expect(await loginSso("javascript:alert(1)")).toEqual({
			ok: false,
			error: "Invalid server URL",
		});
		expect(connection.getServerAuthConfig).not.toHaveBeenCalled();
	});

	it("stops when the server cannot be read or offers no usable provider", async () => {
		connection.getServerAuthConfig.mockResolvedValueOnce({
			ok: false,
			error: "HTTP 502",
		});
		expect(await loginSso("https://wp.example.test")).toEqual({
			ok: false,
			error: "HTTP 502",
		});
		for (const data of [
			{ ...CONFIG, sso_enabled: false },
			{ ...CONFIG, sso_token_endpoint: "http://idp.example.test/token" },
		]) {
			connection.getServerAuthConfig.mockResolvedValueOnce({ ok: true, data });
			expect(await loginSso("https://wp.example.test")).toEqual({
				ok: false,
				error: "Single sign-on is not configured on this server",
			});
		}
		expect(connection.setMode).not.toHaveBeenCalled();
		expect(pkce.acquireIdToken).not.toHaveBeenCalled();
	});

	it("reports a failed browser sign-in", async () => {
		pkce.acquireIdToken.mockRejectedValueOnce(new Error("Sign-in timed out"));
		expect(await loginSso("https://wp.example.test")).toEqual({
			ok: false,
			error: "Sign-in timed out",
		});
		pkce.acquireIdToken.mockRejectedValueOnce("closed");
		expect(await loginSso("https://wp.example.test")).toEqual({
			ok: false,
			error: "closed",
		});
		expect(connection.loginWithSsoIdToken).not.toHaveBeenCalled();
	});
});

describe("the channel", () => {
	it("signs in and tells the window the new state", async () => {
		const send = vi.fn();
		let window: unknown = { webContents: { send } };
		registerServerSsoHandlers(() => window as never);
		const handler = state.handlers.get(IPC_CHANNELS.SERVER_AUTH_LOGIN_SSO);
		expect(await handler?.({}, "https://wp.example.test")).toEqual({
			ok: true,
			user: USER,
		});
		expect(send).toHaveBeenCalledWith(IPC_CHANNELS.SERVER_AUTH_STATE_CHANGED, {
			mode: "server",
			isAuthenticated: true,
		});
		window = null;
		expect(await handler?.({}, 7)).toEqual({
			ok: false,
			error: "Invalid server URL",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});
});
