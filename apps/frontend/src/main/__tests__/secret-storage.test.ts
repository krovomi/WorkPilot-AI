/**
 * @vitest-environment node
 *
 * Secrets at rest (secret-storage.ts): encrypted under the OS keyring when
 * there is one; otherwise kept in clear, never silently — the status the UI
 * reads says so. Rule S1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../__tests__/helpers/fake-safe-storage";

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return { safeStorage: sharedFakeSafeStorage().safeStorage };
});

// The backend check only exists on Linux; pin it so every CI OS runs it.
vi.mock("../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform")>()),
	isLinux: () => true,
}));

const fake = sharedFakeSafeStorage();
type SecretStorage = typeof import("../secret-storage");

async function load(): Promise<SecretStorage> {
	vi.resetModules();
	return import("../secret-storage");
}

describe("secret-storage", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fake.reset();
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		warn.mockRestore();
	});

	describe("with an OS keyring", () => {
		it("encrypts under the enc: prefix without the secret in the output", async () => {
			const storage = await load();

			const stored = storage.encryptSecret("sk-ant-api03-secret");

			expect(stored).toBe(fakeEncrypted("sk-ant-api03-secret"));
			expect(stored.startsWith("enc:")).toBe(true);
			expect(stored).not.toContain("secret");
			expect(storage.decryptSecret(stored)).toBe("sk-ant-api03-secret");
		});

		it("reports the secrets as protected", async () => {
			const storage = await load();
			storage.encryptSecret("sk-live");

			expect(storage.getSecureStorageStatus()).toEqual({
				keyringAvailable: true,
				backend: "gnome_libsecret",
				secretsAtRisk: false,
			});
		});

		it("is idempotent and leaves an empty value alone", async () => {
			const storage = await load();
			const once = storage.encryptSecret("token-value");

			expect(storage.encryptSecret(once)).toBe(once);
			expect(storage.encryptSecret("")).toBe("");
			expect(fake.calls.encrypt).toBe(1);
		});

		it("decrypts each ciphertext once, then serves it from memory", async () => {
			const storage = await load();
			const stored = fakeEncrypted("cached-secret");

			storage.decryptSecret(stored);
			storage.decryptSecret(stored);

			expect(fake.calls.decrypt).toBe(1);
		});
	});

	describe("without an OS keyring", () => {
		it("writes the secret as is and flags it for the UI — never silently", async () => {
			fake.state.ready = false;
			const storage = await load();
			const listener = vi.fn();
			storage.onSecureStorageStatusChange(listener);

			expect(storage.encryptSecret("sk-plain")).toBe("sk-plain");

			const status = storage.getSecureStorageStatus();
			expect(status.keyringAvailable).toBe(false);
			expect(status.secretsAtRisk).toBe(true);
			expect(listener).toHaveBeenLastCalledWith(
				expect.objectContaining({ secretsAtRisk: true }),
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("No OS keyring"),
			);
		});

		it("treats Linux basic_text as no keyring: its key ships with Chromium", async () => {
			fake.state.backend = "basic_text";
			const storage = await load();

			expect(storage.encryptSecret("sk-plain")).toBe("sk-plain");
			expect(storage.getSecureStorageStatus()).toEqual({
				keyringAvailable: false,
				backend: "basic_text",
				secretsAtRisk: true,
			});
			// What basic_text encrypted earlier still reads back.
			expect(storage.decryptSecret(fakeEncrypted("older"))).toBe("older");
		});

		it("flags a failed encryption even though a keyring is reported", async () => {
			fake.state.failEncrypt = true;
			const storage = await load();

			expect(storage.encryptSecret("sk-plain")).toBe("sk-plain");
			expect(storage.getSecureStorageStatus().secretsAtRisk).toBe(true);
		});

		it("flags secrets already on disk, not only new writes", async () => {
			fake.state.ready = false;
			const storage = await load();
			expect(storage.getSecureStorageStatus().secretsAtRisk).toBe(false);

			storage.decryptSecret("legacy-plain-key");

			expect(storage.getSecureStorageStatus().secretsAtRisk).toBe(true);
		});
	});

	describe("decryptSecret", () => {
		it("returns legacy plaintext as is", async () => {
			const storage = await load();
			expect(storage.decryptSecret("sk-legacy")).toBe("sk-legacy");
		});

		it("returns undefined while safeStorage is not ready", async () => {
			fake.state.ready = false;
			const storage = await load();

			expect(storage.decryptSecret(fakeEncrypted("x"))).toBeUndefined();
		});

		it("returns undefined, warning once, when the keyring cannot decrypt", async () => {
			fake.state.failDecrypt = true;
			const storage = await load();

			expect(storage.decryptSecret(fakeEncrypted("a"))).toBeUndefined();
			expect(storage.decryptSecret(fakeEncrypted("b"))).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
		});
	});

	describe("field helpers", () => {
		const isSecret = (key: string) => key === "apiKey";

		it("encrypt only the fields the predicate selects", async () => {
			const storage = await load();

			const stored = storage.encryptSecretFields(
				{ name: "Work", apiKey: "sk-abc" },
				isSecret,
			);

			expect(stored).toEqual({ name: "Work", apiKey: fakeEncrypted("sk-abc") });
		});

		it("keep a value they cannot decrypt, so writing it back preserves it", async () => {
			fake.state.failDecrypt = true;
			const storage = await load();
			const blob = fakeEncrypted("sk-abc");

			const read = storage.decryptSecretFields({ apiKey: blob }, isSecret);

			expect(read.apiKey).toBe(blob);
			expect(storage.encryptSecretFields(read, isSecret).apiKey).toBe(blob);
		});

		it("tell a record still holding a secret in clear", async () => {
			const storage = await load();

			expect(
				storage.hasPlaintextSecretFields({ apiKey: "sk-abc" }, isSecret),
			).toBe(true);
			expect(
				storage.hasPlaintextSecretFields(
					{ apiKey: fakeEncrypted("sk-abc"), name: "clear" },
					isSecret,
				),
			).toBe(false);
			expect(storage.hasPlaintextSecretFields({ apiKey: "" }, isSecret)).toBe(
				false,
			);
		});
	});
});
