import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../shared/i18n";
import type { SecureStorageStatus } from "../../shared/types/ipc";
import {
	setupSecureStorageListeners,
	useSecureStorageStore,
} from "../stores/secure-storage-store";
import { useSettingsStore } from "../stores/settings-store";
import { bannerFingerprint, SecureStorageBanner } from "./SecureStorageBanner";

const protectedStatus: SecureStorageStatus = {
	keyringAvailable: true,
	protection: "os-keyring",
	backend: "gnome_libsecret",
	readableSecretKeys: [],
	secretsAtRisk: false,
	fix: null,
};
const atRiskStatus: SecureStorageStatus = {
	keyringAvailable: false,
	protection: null,
	backend: "basic_text",
	readableSecretKeys: [],
	secretsAtRisk: true,
	fix: "restart",
};
const readableStatus: SecureStorageStatus = {
	keyringAvailable: true,
	protection: "os-keyring",
	backend: "gnome_libsecret",
	readableSecretKeys: ["CONTEXT7_API_KEY"],
	secretsAtRisk: true,
	fix: null,
};
const wslStatus: SecureStorageStatus = { ...atRiskStatus, fix: "retry" };

describe("SecureStorageBanner", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		useSecureStorageStore.setState({ status: null, dismissed: false });
		useSettingsStore.setState((state) => ({
			settings: { ...state.settings, secureStorageBannerHidden: undefined },
		}));
	});

	afterEach(cleanup);

	it("stays hidden while secrets are protected", () => {
		useSecureStorageStore.getState().setStatus(protectedStatus);
		render(<SecureStorageBanner />);

		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("warns while secrets are stored without the keyring", () => {
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		render(<SecureStorageBanner />);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"API keys stored without encryption",
		);
	});

	it("is translated in French", async () => {
		await i18n.changeLanguage("fr");
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		render(<SecureStorageBanner />);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Clés API stockées sans chiffrement",
		);
	});

	it("can be dismissed for the session, and comes back for newly exposed secrets", () => {
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		render(<SecureStorageBanner />);

		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("alert")).toBeNull();

		// Still at risk: the user has been told, it stays dismissed.
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		expect(useSecureStorageStore.getState().dismissed).toBe(true);

		// Protected, then exposed again: a new warning.
		useSecureStorageStore.getState().setStatus(protectedStatus);
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		expect(useSecureStorageStore.getState().dismissed).toBe(false);
	});

	it("names the project keys kept readable, even with a keyring", () => {
		useSecureStorageStore.getState().setStatus(readableStatus);
		render(<SecureStorageBanner />);

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("CONTEXT7_API_KEY");
		expect(alert).toHaveTextContent(".workpilot/.env");
		expect(alert).not.toHaveTextContent("No system keyring");
	});

	it("speaks of the missing keyring first when there is none", () => {
		useSecureStorageStore
			.getState()
			.setStatus({ ...atRiskStatus, readableSecretKeys: ["CONTEXT7_API_KEY"] });
		render(<SecureStorageBanner />);

		expect(screen.getByRole("alert")).toHaveTextContent("No system keyring");
	});

	it("comes back when a project key it has not named yet is kept readable", () => {
		useSecureStorageStore.getState().setStatus(readableStatus);
		useSecureStorageStore.getState().dismiss();

		useSecureStorageStore.getState().setStatus(readableStatus);
		expect(useSecureStorageStore.getState().dismissed).toBe(true);

		useSecureStorageStore.getState().setStatus({
			...readableStatus,
			readableSecretKeys: ["CONTEXT7_API_KEY", "SLACK_WEBHOOK_URL"],
		});
		expect(useSecureStorageStore.getState().dismissed).toBe(false);
	});

	it("pulls the status at startup and follows what the main process pushes", async () => {
		let push: ((status: SecureStorageStatus) => void) | undefined;
		Object.assign(window.electronAPI, {
			getSecureStorageStatus: vi
				.fn()
				.mockResolvedValue({ success: true, data: protectedStatus }),
			onSecureStorageStatusChanged: vi.fn((callback) => {
				push = callback;
				return () => undefined;
			}),
		});

		setupSecureStorageListeners();
		await vi.waitFor(() =>
			expect(useSecureStorageStore.getState().status).toEqual(protectedStatus),
		);

		push?.(atRiskStatus);
		expect(useSecureStorageStore.getState().status).toEqual(atRiskStatus);
	});

	it("under WSL without DPAPI, offers to encrypt now and says when it still cannot", async () => {
		const fixSecureStorage = vi
			.fn()
			.mockResolvedValue({ success: true, data: wslStatus });
		Object.assign(window.electronAPI, { fixSecureStorage });
		useSecureStorageStore.getState().setStatus(wslStatus);
		render(<SecureStorageBanner />);

		expect(screen.getByRole("alert")).toHaveTextContent("DPAPI");
		fireEvent.click(screen.getByRole("button", { name: "Encrypt now" }));

		await vi.waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Windows encryption is still unreachable.",
			),
		);
		expect(fixSecureStorage).toHaveBeenCalledWith();
	});

	it("goes away once the fix encrypts the secrets", async () => {
		Object.assign(window.electronAPI, {
			fixSecureStorage: vi.fn().mockResolvedValue({
				success: true,
				data: { ...protectedStatus, protection: "windows-dpapi" },
			}),
		});
		useSecureStorageStore.getState().setStatus(wslStatus);
		render(<SecureStorageBanner />);

		fireEvent.click(screen.getByRole("button", { name: "Encrypt now" }));

		await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("offers a restart on Linux, where the keyring is chosen at launch", () => {
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		render(<SecureStorageBanner />);

		expect(
			screen.getByRole("button", { name: "Restart WorkPilot AI" }),
		).toBeInTheDocument();
	});

	it("\"Don't show again\" hides this situation for good, not a new one", async () => {
		const saveSettings = vi.fn().mockResolvedValue({ success: true });
		Object.assign(window.electronAPI, { saveSettings });
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		render(<SecureStorageBanner />);

		fireEvent.click(screen.getByRole("button", { name: "Don't show again" }));

		await vi.waitFor(() =>
			expect(saveSettings).toHaveBeenCalledWith({
				secureStorageBannerHidden: "no-encryption",
			}),
		);
		await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

		// Another situation (a project key kept readable) still warns.
		useSecureStorageStore.getState().setStatus(readableStatus);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"CONTEXT7_API_KEY",
		);
	});

	it("fingerprints a situation by what is exposed, never by a value", () => {
		expect(bannerFingerprint(atRiskStatus)).toBe("no-encryption");
		expect(
			bannerFingerprint({
				keyringAvailable: true,
				readableSecretKeys: ["B_KEY", "A_KEY"],
			}),
		).toBe("readable:A_KEY,B_KEY");
	});

	it("is translated in French, buttons included", async () => {
		await i18n.changeLanguage("fr");
		useSecureStorageStore.getState().setStatus(wslStatus);
		render(<SecureStorageBanner />);

		expect(
			screen.getByRole("button", { name: "Chiffrer maintenant" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Ne plus afficher" }),
		).toBeInTheDocument();
	});
});
