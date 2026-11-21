/**
 * @vitest-environment node
 *
 * Startup never waits on the keyring (secret-storage.ts). On Linux a locked
 * keyring answers the first encryption with an unlock prompt that may never
 * show (blank under WSLg): the app must go on without it, and never reach the
 * synchronous safeStorage API, which would freeze the main process.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../__tests__/helpers/fake-safe-storage";

const linux = vi.hoisted(() => ({ value: true }));
const keyring = vi.hoisted(() => ({
	/** Which async call waits forever, as on a prompt nobody can answer. */
	hangs: "none" as "none" | "probe" | "encrypt",
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	const fake = sharedFakeSafeStorage().safeStorage;
	const never = () => new Promise<never>(() => undefined);
	return {
		app: { isReady: () => true },
		safeStorage: {
			...fake,
			isAsyncEncryptionAvailable: () =>
				keyring.hangs === "probe" ? never() : fake.isAsyncEncryptionAvailable(),
			encryptStringAsync: (value: string) =>
				keyring.hangs === "encrypt" ? never() : fake.encryptStringAsync(value),
			decryptString: (value: Buffer) => fake.decryptString(value),
			encryptString: (value: string) => fake.encryptString(value),
			isEncryptionAvailable: () => fake.isEncryptionAvailable(),
		},
	};
});

vi.mock("../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform")>()),
	isLinux: () => linux.value,
}));

const fake = sharedFakeSafeStorage();
type SecretStorage = typeof import("../secret-storage");

async function load(): Promise<SecretStorage> {
	vi.resetModules();
	return import("../secret-storage");
}

describe("secret-storage and a keyring that does not answer", () => {
	let warn: ReturnType<typeof vi.spyOn>;
	let dir: string;

	beforeEach(() => {
		fake.reset();
		linux.value = true;
		keyring.hangs = "none";
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		dir = mkdtempSync(path.join(tmpdir(), "secret-storage-timeout-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		warn.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	});

	async function initPastTimeout(
		storage: SecretStorage,
		files: string[] = [],
	): Promise<void> {
		vi.useFakeTimers();
		const init = storage.initSecretStorage(files);
		await vi.advanceTimersByTimeAsync(storage.KEYRING_TIMEOUT_MS * 3);
		await init;
	}

	it.each([
		["the availability probe", "probe"],
		["the first encryption (where a locked keyring prompts)", "encrypt"],
	] as const)("goes on without the keyring when %s hangs", async (_case, hangs) => {
		keyring.hangs = hangs;
		const settings = path.join(dir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ globalOpenAIApiKey: fakeEncrypted("sk-openai") }),
			"utf-8",
		);
		const storage = await load();
		const decryptSync = vi.spyOn(fake.safeStorage, "decryptString");
		const encryptSync = vi.spyOn(fake.safeStorage, "encryptString");

		await initPastTimeout(storage, [settings]);

		// Kept as stored, never decrypted synchronously.
		expect(storage.decryptSecret(fakeEncrypted("sk-openai"))).toBeUndefined();
		// A new secret is written in clear, and the banner is told.
		expect(storage.encryptSecret("sk-new")).toBe("sk-new");
		expect(storage.getSecureStorageStatus()).toMatchObject({
			keyringAvailable: false,
			secretsAtRisk: true,
		});
		expect(decryptSync).not.toHaveBeenCalled();
		expect(encryptSync).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("did not answer"),
		);
		await expect(storage.asyncEncryptionUsable()).resolves.toBe(false);
		expect(storage.guardedSafeStorage.isEncryptionAvailable()).toBe(false);
	});

	it("never calls the sync API on Linux before the async probe answered", async () => {
		const storage = await load();
		const decryptSync = vi.spyOn(fake.safeStorage, "decryptString");
		const probeSync = vi.spyOn(fake.safeStorage, "isEncryptionAvailable");

		// A settings read before initSecretStorage (initAppLanguage…).
		expect(storage.decryptSecret(fakeEncrypted("sk-early"))).toBeUndefined();
		expect(storage.guardedSafeStorage.isEncryptionAvailable()).toBe(false);
		expect(decryptSync).not.toHaveBeenCalled();
		expect(probeSync).not.toHaveBeenCalled();

		await storage.initSecretStorage();

		expect(storage.decryptSecret(fakeEncrypted("sk-early"))).toBe("sk-early");
		expect(storage.guardedSafeStorage.isEncryptionAvailable()).toBe(true);
	});

	it("uses the keyring as before once it answers in time", async () => {
		const settings = path.join(dir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ globalOpenAIApiKey: fakeEncrypted("sk-openai") }),
			"utf-8",
		);
		const storage = await load();

		await storage.initSecretStorage([settings]);

		expect(storage.decryptSecret(fakeEncrypted("sk-openai"))).toBe("sk-openai");
		expect(storage.encryptSecret("sk-new")).toBe(fakeEncrypted("sk-new"));
		expect(storage.getSecureStorageStatus().keyringAvailable).toBe(true);
		await expect(storage.asyncEncryptionUsable()).resolves.toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});

	it("treats a keyring that refuses the probe as unavailable", async () => {
		fake.state.failEncrypt = true;
		const storage = await load();

		await storage.initSecretStorage();

		expect(storage.getSecureStorageStatus().keyringAvailable).toBe(false);
		await expect(storage.asyncEncryptionUsable()).resolves.toBe(false);
	});

	it("does not bound the keyring outside Linux: macOS shows a dialog the user answers", async () => {
		linux.value = false;
		keyring.hangs = "probe";
		const storage = await load();
		vi.useFakeTimers();
		let settled = false;
		void storage.initSecretStorage().then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(storage.KEYRING_TIMEOUT_MS * 3);

		expect(settled).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});

	it("hands the stores of their own the keyring once it answered", async () => {
		const storage = await load();
		await storage.initSecretStorage();
		const guarded = storage.guardedSafeStorage;

		const encrypted = guarded.encryptString("sk-vault");

		expect(guarded.decryptString(encrypted)).toBe("sk-vault");
		expect(guarded.getSelectedStorageBackend()).toBe("gnome_libsecret");
	});

	it("answers asyncEncryptionUsable before init, bounded on Linux", async () => {
		keyring.hangs = "probe";
		const storage = await load();
		vi.useFakeTimers();

		const usable = storage.asyncEncryptionUsable();
		await vi.advanceTimersByTimeAsync(storage.KEYRING_TIMEOUT_MS + 1);

		await expect(usable).resolves.toBe(false);
	});
});
