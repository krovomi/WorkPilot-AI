/**
 * @vitest-environment node
 *
 * WSL without a usable Linux keyring (secret-storage.ts): secrets are
 * encrypted with the key Windows DPAPI keeps (wsl-secret-key.ts, mocked here),
 * as `encw:` AES-256-GCM, and the banner has nothing to say. Without DPAPI
 * either, they stay in clear with the banner, whose "retry" asks again.
 */

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../__tests__/helpers/fake-safe-storage";

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { isReady: () => true },
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

vi.mock("../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform")>()),
	isLinux: () => true,
}));

vi.mock("../platform/wsl", () => ({ detectWsl: () => true }));

const dpapi = vi.hoisted(() => ({
	key: null as Buffer | null,
	load: vi.fn(),
}));

vi.mock("../wsl-secret-key", () => ({
	loadWslSecretKey: (options: { create: boolean }) => dpapi.load(options),
}));

const fake = sharedFakeSafeStorage();
type SecretStorage = typeof import("../secret-storage");

async function load(): Promise<SecretStorage> {
	vi.resetModules();
	return import("../secret-storage");
}

describe("secret-storage under WSL", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fake.reset();
		fake.state.backend = "basic_text";
		dpapi.key = randomBytes(32);
		dpapi.load.mockReset();
		dpapi.load.mockImplementation(async () => dpapi.key);
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		warn.mockRestore();
	});

	it("encrypts with the DPAPI key when no keyring can, and says nothing is at risk", async () => {
		const storage = await load();
		await storage.initSecretStorage();

		const stored = storage.encryptSecret("sk-test-0000");

		expect(stored.startsWith(storage.APP_KEY_SECRET_PREFIX)).toBe(true);
		expect(stored).not.toContain("sk-test");
		expect(storage.isEncryptedSecret(stored)).toBe(true);
		expect(storage.decryptSecret(stored)).toBe("sk-test-0000");
		// A fresh IV each time: the same secret never gives the same value.
		expect(storage.encryptSecret("sk-test-0000")).not.toBe(stored);
		expect(dpapi.load).toHaveBeenCalledWith({ create: true });
		expect(storage.getSecureStorageStatus()).toMatchObject({
			keyringAvailable: true,
			protection: "windows-dpapi",
			secretsAtRisk: false,
			fix: null,
		});
	});

	it("keeps using the keyring when one encrypts, and only reads the DPAPI key", async () => {
		fake.state.backend = "gnome_libsecret";
		const storage = await load();
		await storage.initSecretStorage();

		expect(dpapi.load).toHaveBeenCalledWith({ create: false });
		expect(storage.encryptSecret("sk-test-0000")).toBe(
			fakeEncrypted("sk-test-0000"),
		);
		expect(storage.getSecureStorageStatus().protection).toBe("os-keyring");
	});

	it("still reads what the DPAPI key encrypted once a keyring is back", async () => {
		const before = await load();
		await before.initSecretStorage();
		const stored = before.encryptSecret("sk-test-0000");

		fake.state.backend = "gnome_libsecret";
		const after = await load();
		await after.initSecretStorage();

		expect(after.decryptSecret(stored)).toBe("sk-test-0000");
	});

	it("keeps a value it cannot open, as it does for the keyring", async () => {
		const storage = await load();
		await storage.initSecretStorage();
		const stored = storage.encryptSecret("sk-test-0000");
		const body = Buffer.from(
			stored.slice(storage.APP_KEY_SECRET_PREFIX.length),
			"base64",
		);
		body[body.length - 1] ^= 1;
		const tampered = `${storage.APP_KEY_SECRET_PREFIX}${body.toString("base64")}`;

		expect(storage.decryptSecret(tampered)).toBeUndefined();
		expect(storage.decryptSecret("encw:AAAA")).toBeUndefined();
		expect(
			storage.decryptSecretFields({ apiKey: tampered }, () => true).apiKey,
		).toBe(tampered);

		dpapi.key = null;
		const withoutKey = await load();
		await withoutKey.initSecretStorage();
		expect(withoutKey.decryptSecret(stored)).toBeUndefined();
	});

	it("without DPAPI, writes in clear with the banner, whose retry encrypts what was left in clear", async () => {
		dpapi.key = null;
		const storage = await load();
		await storage.initSecretStorage();

		expect(storage.encryptSecret("sk-test-0000")).toBe("sk-test-0000");
		expect(storage.getSecureStorageStatus()).toMatchObject({
			keyringAvailable: false,
			protection: null,
			secretsAtRisk: true,
			fix: "retry",
		});

		const rewrite = vi.fn(async () => {
			expect(storage.encryptSecret("sk-test-0000")).toMatch(/^encw:/);
		});
		storage.setPlaintextSecretsRewriter(rewrite);
		dpapi.key = randomBytes(32);

		expect(await storage.retrySecretEncryption()).toBe(true);
		expect(rewrite).toHaveBeenCalledTimes(1);
		expect(dpapi.load).toHaveBeenLastCalledWith({ create: true });
		expect(storage.getSecureStorageStatus()).toMatchObject({
			protection: "windows-dpapi",
			secretsAtRisk: false,
			fix: null,
		});
	});

	it("a retry that still cannot reach DPAPI rewrites nothing", async () => {
		dpapi.key = null;
		const storage = await load();
		await storage.initSecretStorage();
		storage.encryptSecret("sk-test-0000");
		const rewrite = vi.fn(async () => undefined);
		storage.setPlaintextSecretsRewriter(rewrite);

		expect(await storage.retrySecretEncryption()).toBe(false);
		expect(rewrite).not.toHaveBeenCalled();
		expect(storage.getSecureStorageStatus().secretsAtRisk).toBe(true);
	});

	it("uses the key unwrapped before ready instead of asking DPAPI again", async () => {
		const storage = await load();
		storage.preloadAppKey();
		storage.preloadAppKey();
		await storage.initSecretStorage();

		expect(dpapi.load).toHaveBeenCalledTimes(1);
		expect(dpapi.load).toHaveBeenCalledWith({ create: false });
		expect(storage.encryptSecret("sk-test-0000")).toMatch(/^encw:/);
	});

	it("creates the key at init when the preload found none on disk", async () => {
		dpapi.load.mockImplementation(async ({ create }) =>
			create ? dpapi.key : null,
		);
		const storage = await load();
		storage.preloadAppKey();
		await storage.initSecretStorage();

		expect(dpapi.load).toHaveBeenNthCalledWith(1, { create: false });
		expect(dpapi.load).toHaveBeenNthCalledWith(2, { create: true });
		expect(storage.getSecureStorageStatus().protection).toBe("windows-dpapi");
	});

	it("survives a DPAPI loader that throws", async () => {
		dpapi.load.mockRejectedValue(new Error("interop off"));
		const storage = await load();
		storage.preloadAppKey();
		await storage.initSecretStorage();

		expect(storage.encryptSecret("sk-test-0000")).toBe("sk-test-0000");
		expect(storage.getSecureStorageStatus().fix).toBe("retry");
	});
});
