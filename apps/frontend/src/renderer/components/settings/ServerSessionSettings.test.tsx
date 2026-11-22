/** @vitest-environment jsdom */
/**
 * My session on the server: who is signed in and how the session was opened,
 * as main reports it, a refusal shown as such, and the sign-out.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { ServerSessionInfo } from "../../../shared/types/server-session";

const logout = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/stores/server-session-store", () => ({
	useServerSessionStore: (select: (s: { logout: typeof logout }) => unknown) =>
		select({ logout }),
}));

import { ServerSessionSettings } from "./ServerSessionSettings";

const SESSION: ServerSessionInfo = {
	serverUrl: "https://wp.example.test",
	user: { email: "ada@example.com", displayName: "Ada", role: "member" },
	method: "oidc",
	providerName: "Okta",
	issuerHost: "login.example.test",
	signedInAt: "2026-11-22T08:30:00Z",
};

const getSession = vi.fn();

beforeEach(() => {
	getSession.mockReset();
	logout.mockClear();
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAuth: { getSession } };
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("ServerSessionSettings", () => {
	it("shows the identity and the provider the session was opened with", async () => {
		getSession.mockResolvedValue({ success: true, data: SESSION });
		render(<ServerSessionSettings />);
		expect(await screen.findByText("Ada (ada@example.com)")).toBeInTheDocument();
		expect(screen.getByText("Single sign-on: Okta")).toBeInTheDocument();
		expect(screen.getByText("login.example.test")).toBeInTheDocument();
		expect(screen.getByText("https://wp.example.test")).toBeInTheDocument();
		expect(screen.getByText("member")).toBeInTheDocument();
		expect(screen.getByText("Signed in at")).toBeInTheDocument();
	});

	it.each([
		["local", "Password"],
		["entra", "Microsoft Entra ID"],
		["invite", "Accepted invitation"],
		[null, "Not recorded (session opened before the server named sign-ins)"],
	] as const)("names a %s sign-in", async (method, label) => {
		getSession.mockResolvedValue({
			success: true,
			data: {
				...SESSION,
				method,
				providerName: null,
				issuerHost: null,
				signedInAt: null,
				user: { ...SESSION.user, role: "" },
			},
		});
		render(<ServerSessionSettings />);
		expect(await screen.findByText(label)).toBeInTheDocument();
		expect(screen.queryByText("Identity provider")).not.toBeInTheDocument();
		expect(screen.queryByText("Signed in at")).not.toBeInTheDocument();
		expect(screen.queryByText("Role")).not.toBeInTheDocument();
	});

	it("names a single sign-on without a provider name", async () => {
		getSession.mockResolvedValue({
			success: true,
			data: { ...SESSION, providerName: null },
		});
		render(<ServerSessionSettings />);
		expect(await screen.findByText("Single sign-on: SSO")).toBeInTheDocument();
	});

	it("shows why the session cannot be read", async () => {
		getSession.mockResolvedValueOnce({ success: false, error: "Not authenticated" });
		render(<ServerSessionSettings />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Not authenticated");
		cleanup();
		getSession.mockResolvedValueOnce({ success: false });
		render(<ServerSessionSettings />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The session cannot be read from the server",
		);
	});

	it("ignores an answer that comes after the page is gone", async () => {
		let answer: (value: unknown) => void = () => undefined;
		getSession.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const { unmount } = render(<ServerSessionSettings />);
		expect(screen.getByLabelText("Loading the session")).toBeInTheDocument();
		unmount();
		answer({ success: true, data: SESSION });
		await Promise.resolve();
		expect(screen.queryByText("Ada (ada@example.com)")).not.toBeInTheDocument();
	});

	it("signs out", async () => {
		getSession.mockResolvedValue({ success: true, data: SESSION });
		render(<ServerSessionSettings />);
		fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled(),
		);
	});
});
