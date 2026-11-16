/**
 * Signing in to Claude from the setup modal: a terminal opens on the active
 * profile, the user runs /login there, then comes back and asks the app to
 * check.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { ClaudeOAuthFlow } from "../ClaudeOAuthFlow";

const api = {
	getClaudeProfiles: vi.fn(),
	authenticateClaudeProfile: vi.fn(),
	verifyClaudeProfileAuth: vi.fn(),
};

let previousApi: unknown;

beforeEach(async () => {
	await i18n.changeLanguage("en");
	for (const fn of Object.values(api)) fn.mockReset();
	api.getClaudeProfiles.mockResolvedValue({
		success: true,
		data: { activeProfileId: "work" },
	});
	api.authenticateClaudeProfile.mockResolvedValue({ success: true });
	previousApi = (globalThis as { electronAPI?: unknown }).electronAPI;
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = previousApi;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function start(props: { onCancel?: () => void } = {}) {
	const onSuccess = vi.fn();
	const view = render(<ClaudeOAuthFlow onSuccess={onSuccess} {...props} />);
	return { onSuccess, ...view };
}

async function signIn() {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Authenticate with Claude" }));
	});
}

describe("ClaudeOAuthFlow", () => {
	it("opens the terminal on the active profile and waits for the user", async () => {
		start();
		await signIn();
		expect(api.authenticateClaudeProfile).toHaveBeenCalledWith("work");
		expect(screen.getByText("Complete Authentication")).toBeTruthy();
		expect(screen.getByText("/login").tagName).toBe("CODE");
	});

	it("asks to finish /login first when verify is pressed too early", async () => {
		api.getClaudeProfiles.mockReturnValue(new Promise(() => undefined));
		start();
		await signIn();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Verify Authentication" }));
		});
		expect(screen.getByText("No profile selected for verification")).toBeTruthy();
		expect(api.verifyClaudeProfileAuth).not.toHaveBeenCalled();
	});

	it("shows the account and moves on once the sign-in is found", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let release: (v: unknown) => void = () => undefined;
		api.verifyClaudeProfileAuth.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const { onSuccess } = start();
		await signIn();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Verify Authentication" }));
		});
		expect(screen.getByText("Verifying Authentication...")).toBeTruthy();
		await act(async () =>
			release({ success: true, data: { authenticated: true, email: "a@b.c" } }),
		);
		expect(api.verifyClaudeProfileAuth).toHaveBeenCalledWith("work");
		expect(screen.getByText("Connected as a@b.c")).toBeTruthy();
		expect(onSuccess).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it("says the credentials are saved when no email comes back", async () => {
		api.verifyClaudeProfileAuth.mockResolvedValue({
			success: true,
			data: { authenticated: true },
		});
		start();
		await signIn();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Verify Authentication" }));
		});
		expect(screen.getByText(/credentials have been saved/i)).toBeTruthy();
	});

	it("does not call back once the modal is gone", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.verifyClaudeProfileAuth.mockResolvedValue({
			success: true,
			data: { authenticated: true },
		});
		const { onSuccess, unmount } = start();
		await signIn();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Verify Authentication" }));
		});
		unmount();
		vi.advanceTimersByTime(2000);
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("keeps waiting when the sign-in is not found or the check fails", async () => {
		start();
		await signIn();
		const verify = () =>
			act(async () => {
				fireEvent.click(screen.getByRole("button", { name: "Verify Authentication" }));
			});

		api.verifyClaudeProfileAuth.mockResolvedValueOnce({
			success: true,
			data: { authenticated: false },
		});
		await verify();
		expect(screen.getByText(/Authentication not detected/)).toBeTruthy();

		api.verifyClaudeProfileAuth.mockRejectedValueOnce(new Error("keychain locked"));
		await verify();
		expect(screen.getByText("keychain locked")).toBeTruthy();

		api.verifyClaudeProfileAuth.mockRejectedValueOnce("odd");
		await verify();
		expect(screen.getByText("Could not check the sign-in")).toBeTruthy();
		expect(screen.getByText("Complete Authentication")).toBeTruthy();
	});

	it.each([
		["profiles cannot be read", () => api.getClaudeProfiles.mockResolvedValue({ success: false }), "Could not read the Claude profiles"],
		["the terminal does not open", () => api.authenticateClaudeProfile.mockResolvedValue({ success: false }), "Could not open the sign-in terminal"],
		["the main process explains", () => api.authenticateClaudeProfile.mockResolvedValue({ success: false, error: "no shell" }), "no shell"],
		["something odd is thrown", () => api.getClaudeProfiles.mockRejectedValue("odd"), "Authentication Failed"],
	])("shows the failure when %s, and lets the user retry", async (_case, arrange, message) => {
		arrange();
		start();
		await signIn();
		expect(screen.getAllByText(message).length).toBeGreaterThan(0);

		api.getClaudeProfiles.mockResolvedValue({
			success: true,
			data: { activeProfileId: "work" },
		});
		api.authenticateClaudeProfile.mockResolvedValue({ success: true });
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await signIn();
		expect(screen.getByText("Complete Authentication")).toBeTruthy();
	});

	it("offers to skip while waiting and to cancel after a failure", async () => {
		const onCancel = vi.fn();
		start({ onCancel });
		fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
		await signIn();
		fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
		expect(onCancel).toHaveBeenCalledTimes(2);
	});

	it("offers cancel on the error screen only when the caller allows it", async () => {
		api.getClaudeProfiles.mockResolvedValue({ success: false });
		const onCancel = vi.fn();
		const first = start({ onCancel });
		await signIn();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalled();
		first.unmount();

		start();
		await signIn();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		api.getClaudeProfiles.mockResolvedValue({ success: false });
		start();
		await act(async () => {
			fireEvent.click(screen.getAllByRole("button")[0]);
		});
		expect(screen.getAllByText("Impossible de lire les profils Claude").length).toBeGreaterThan(0);
	});
});
