import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../shared/i18n";
import type { SecureStorageStatus } from "../../shared/types/ipc";
import {
	setupSecureStorageListeners,
	useSecureStorageStore,
} from "../stores/secure-storage-store";
import { SecureStorageBanner } from "./SecureStorageBanner";

const protectedStatus: SecureStorageStatus = {
	keyringAvailable: true,
	backend: "gnome_libsecret",
	secretsAtRisk: false,
	encryptionUnavailable: false,
	plaintextFiles: [],
};
const atRiskStatus: SecureStorageStatus = {
	keyringAvailable: false,
	backend: "basic_text",
	secretsAtRisk: true,
	encryptionUnavailable: true,
	plaintextFiles: [],
};
const BACKEND_ENV = "/home/dev/WorkPilot-AI/apps/backend/.env";
/** Running from source with a keyring: only the backend's .env is in clear. */
const plaintextFileStatus: SecureStorageStatus = {
	keyringAvailable: true,
	backend: "gnome_libsecret",
	secretsAtRisk: true,
	encryptionUnavailable: false,
	plaintextFiles: [BACKEND_ENV],
};

describe("SecureStorageBanner", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		useSecureStorageStore.setState({ status: null, dismissed: false });
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

	it("names a file kept in clear for Python, without blaming a keyring that works", () => {
		useSecureStorageStore.getState().setStatus(plaintextFileStatus);
		render(<SecureStorageBanner />);

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("API keys stored without encryption");
		expect(alert).toHaveTextContent("the Python backend reads its own .env");
		expect(alert).toHaveTextContent(BACKEND_ENV);
		expect(alert).not.toHaveTextContent("No system keyring is available");
	});

	it("gives both reasons when both hold", () => {
		useSecureStorageStore.getState().setStatus({
			...atRiskStatus,
			plaintextFiles: [BACKEND_ENV],
		});
		render(<SecureStorageBanner />);

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("No system keyring is available");
		expect(alert).toHaveTextContent(BACKEND_ENV);
	});

	it("is translated in French", async () => {
		await i18n.changeLanguage("fr");
		useSecureStorageStore.getState().setStatus(atRiskStatus);
		render(<SecureStorageBanner />);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Clés API stockées sans chiffrement",
		);
	});

	it("names the file kept in clear in French too", async () => {
		await i18n.changeLanguage("fr");
		useSecureStorageStore.getState().setStatus(plaintextFileStatus);
		render(<SecureStorageBanner />);

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("le backend Python lit lui-même son .env");
		expect(alert).toHaveTextContent(BACKEND_ENV);
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
});
