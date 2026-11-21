/** @vitest-environment jsdom */
/**
 * The connection gate offers the sign-in of the server's OpenID Connect
 * provider, named by the server, only when the server offers it.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { useServerSessionStore } from "../../stores/server-session-store";
import { ServerLoginScreen } from "./ServerLoginScreen";

const getConfig = vi.fn();
const loginSso = vi.fn();

function config(extra: Record<string, unknown>) {
	return {
		ok: true,
		data: {
			local_enabled: true,
			entra_enabled: false,
			entra_tenant_id: null,
			entra_client_id: null,
			...extra,
		},
	};
}

beforeEach(() => {
	getConfig.mockReset();
	loginSso.mockReset();
	localStorage.clear();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		serverAuth: { getConfig },
	};
	useServerSessionStore.setState({ serverUrl: "https://wp.example.test", loginSso });
});

afterEach(() => {
	cleanup();
});

async function button(name: RegExp) {
	return await screen.findByRole("button", { name }, { timeout: 2000 });
}

describe("ServerLoginScreen single sign-on", () => {
	it("names the provider and signs in with it", async () => {
		getConfig.mockResolvedValue(config({ sso_enabled: true, sso_name: "Okta" }));
		let finish: (value: unknown) => void = () => undefined;
		loginSso.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		render(<ServerLoginScreen />);
		const okta = await button(/Sign in with Okta/);
		fireEvent.click(okta);
		await waitFor(() => expect(okta).toBeDisabled());
		expect(loginSso).toHaveBeenCalledWith("https://wp.example.test");
		expect(localStorage.getItem("workpilot-last-server-url")).toBe(
			"https://wp.example.test",
		);
		finish({ ok: true });
		await waitFor(() => expect(okta).toBeEnabled());
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows why a sign-in failed, or a generic failure", async () => {
		getConfig.mockResolvedValue(config({ sso_enabled: true, sso_name: "" }));
		loginSso
			.mockResolvedValueOnce({ ok: false, error: "Sign-in timed out" })
			.mockResolvedValueOnce({ ok: false });
		render(<ServerLoginScreen />);
		const sso = await button(/Sign in with SSO/);
		fireEvent.click(sso);
		expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in timed out");
		fireEvent.click(sso);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("Could not sign in"),
		);
	});

	it("offers no single sign-on the server does not offer", async () => {
		for (const answer of [
			config({ sso_enabled: false, sso_name: "Okta" }),
			{ ok: false, error: "HTTP 502" },
		]) {
			getConfig.mockResolvedValue(answer);
			render(<ServerLoginScreen />);
			await waitFor(() => expect(getConfig).toHaveBeenCalled(), { timeout: 2000 });
			expect(screen.queryByRole("button", { name: /Okta/ })).not.toBeInTheDocument();
			cleanup();
			getConfig.mockReset();
		}
	});
});
