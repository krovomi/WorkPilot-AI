/**
 * @vitest-environment node
 *
 * settings.json holds the global provider keys. settings-utils is its only
 * reader and writer: secrets encrypted on write, decrypted on read, legacy
 * plaintext migrated, and the file restricted to its owner.
 */

import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../__tests__/helpers/fake-safe-storage";

const paths = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => paths.userData },
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

const fake = sharedFakeSafeStorage();
const NOW = new Date("2026-10-30T12:00:00.000Z");
const isWindows = process.platform === "win32";

type SettingsUtils = typeof import("../settings-utils");
type SecretStorage = typeof import("../secret-storage");

async function load(): Promise<SettingsUtils & SecretStorage> {
	vi.resetModules();
	return {
		...(await import("../settings-utils")),
		...(await import("../secret-storage")),
	};
}

function settingsFile(): string {
	return path.join(paths.userData, "settings.json");
}

function onDisk(): Record<string, unknown> {
	return JSON.parse(readFileSync(settingsFile(), "utf-8"));
}

describe("settings.json secrets", () => {
	beforeEach(() => {
		fake.reset();
		paths.userData = mkdtempSync(path.join(tmpdir(), "settings-secrets-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		rmSync(paths.userData, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("names the secret keys, including the ones only the provider grid uses", async () => {
		const { isSecretSettingsKey } = await load();

		for (const key of [
			"globalOpenAIApiKey",
			"globalAnthropicApiKey",
			"globalClaudeOAuthToken",
			"globalOpenAICodexOAuthToken",
			"globalWindsurfApiKey",
			"globalAzureApiKey",
			"globalAwsAccessKey",
			"customProviderApiKey",
		]) {
			expect(isSecretSettingsKey(key), key).toBe(true);
		}
		for (const key of [
			"theme",
			"globalOllamaApiUrl",
			"globalOllamaModel",
			"globalAzureApiBaseUrl",
			"globalOpenAIAuthMode",
			"selectedProvider",
		]) {
			expect(isSecretSettingsKey(key), key).toBe(false);
		}
	});

	it("writes secret keys encrypted and everything else as is", async () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
		const { writeSettingsFile } = await load();

		writeSettingsFile({
			theme: "dark",
			globalOllamaApiUrl: "http://localhost:11434",
			globalOpenAIApiKey: "sk-proj-secret",
			globalClaudeOAuthToken: "sk-ant-oat01-secret",
		});

		const raw = readFileSync(settingsFile(), "utf-8");
		expect(raw).not.toContain("secret");
		expect(onDisk()).toEqual({
			theme: "dark",
			globalOllamaApiUrl: "http://localhost:11434",
			globalOpenAIApiKey: fakeEncrypted("sk-proj-secret"),
			globalClaudeOAuthToken: fakeEncrypted("sk-ant-oat01-secret"),
			credentialsSetAt: {
				globalOpenAIApiKey: NOW.toISOString(),
				globalClaudeOAuthToken: NOW.toISOString(),
			},
		});
	});

	it.skipIf(isWindows)("restricts the file to its owner (0600)", async () => {
		writeFileSync(settingsFile(), "{}", { mode: 0o644 });
		const { writeSettingsFile } = await load();

		writeSettingsFile({ globalOpenAIApiKey: "sk-proj-secret" });

		expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
	});

	it("reads the secrets back decrypted", async () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
		const utils = await load();
		utils.writeSettingsFile({ theme: "dark", globalGroqApiKey: "gsk_secret" });

		const expected = {
			theme: "dark",
			globalGroqApiKey: "gsk_secret",
			credentialsSetAt: { globalGroqApiKey: NOW.toISOString() },
		};
		expect(utils.readSettingsFile()).toEqual(expected);
		await expect(utils.readSettingsFileAsync()).resolves.toEqual(expected);
	});

	describe("secret dates (S5)", () => {
		const LATER = new Date("2027-02-01T09:00:00.000Z");

		it("keeps a key's date while its value is unchanged", async () => {
			vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
			const utils = await load();
			utils.writeSettingsFile({ globalOpenAIApiKey: "sk-proj-secret" });

			vi.setSystemTime(LATER);
			const current = utils.readSettingsFile() ?? {};
			const dates = utils.writeSettingsFile({ ...current, theme: "light" });

			expect(dates).toEqual({ globalOpenAIApiKey: NOW.toISOString() });
			expect(onDisk().credentialsSetAt).toEqual(dates);
		});

		it("dates a changed key on the day it changes", async () => {
			vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
			const utils = await load();
			utils.writeSettingsFile({
				globalOpenAIApiKey: "sk-proj-old",
				globalGroqApiKey: "gsk_kept",
			});

			vi.setSystemTime(LATER);
			const dates = utils.writeSettingsFile({
				...utils.readSettingsFile(),
				globalOpenAIApiKey: "sk-proj-new",
			});

			expect(dates).toEqual({
				globalOpenAIApiKey: LATER.toISOString(),
				globalGroqApiKey: NOW.toISOString(),
			});
		});

		it("never takes the dates from the caller", async () => {
			vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
			const utils = await load();

			utils.writeSettingsFile({
				globalOpenAIApiKey: "sk-proj-secret",
				credentialsSetAt: { globalOpenAIApiKey: "2020-01-01T00:00:00.000Z" },
			});

			expect(onDisk().credentialsSetAt).toEqual({
				globalOpenAIApiKey: NOW.toISOString(),
			});
		});

		it("drops the date of an emptied key", async () => {
			const utils = await load();
			utils.writeSettingsFile({ globalOpenAIApiKey: "sk-proj-secret" });

			utils.writeSettingsFile({ globalOpenAIApiKey: "" });

			expect(onDisk()).toEqual({ globalOpenAIApiKey: "" });
		});

		it("leaves a key stored before dating undated, never 'saved today'", async () => {
			writeFileSync(
				settingsFile(),
				JSON.stringify({ globalAnthropicApiKey: "sk-ant-legacy" }),
			);
			const utils = await load();

			utils.migrateSettingsSecrets();
			utils.writeSettingsFile({ ...utils.readSettingsFile(), theme: "dark" });

			expect(onDisk().credentialsSetAt).toBeUndefined();
		});
	});

	describe("migration of a file written in clear", () => {
		beforeEach(() => {
			writeFileSync(
				settingsFile(),
				JSON.stringify({
					theme: "light",
					globalAnthropicApiKey: "sk-ant-legacy",
					globalMistralApiKey: "",
				}),
				{ mode: 0o644 },
			);
		});

		it("encrypts the legacy secrets and keeps every other field", async () => {
			const utils = await load();

			expect(utils.migrateSettingsSecrets()).toBe(true);

			expect(onDisk()).toEqual({
				theme: "light",
				globalAnthropicApiKey: fakeEncrypted("sk-ant-legacy"),
				globalMistralApiKey: "",
			});
			expect(utils.readSettingsFile()?.globalAnthropicApiKey).toBe(
				"sk-ant-legacy",
			);
			if (!isWindows) {
				expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
			}
		});

		it("is a no-op once the file is encrypted", async () => {
			const utils = await load();
			utils.migrateSettingsSecrets();
			const migrated = readFileSync(settingsFile(), "utf-8");

			expect(utils.migrateSettingsSecrets()).toBe(false);
			expect(readFileSync(settingsFile(), "utf-8")).toBe(migrated);
		});

		it("without a keyring keeps them in clear and flags them for the UI", async () => {
			fake.state.ready = false;
			const utils = await load();

			utils.migrateSettingsSecrets();

			expect(onDisk().globalAnthropicApiKey).toBe("sk-ant-legacy");
			expect(utils.getSecureStorageStatus().secretsAtRisk).toBe(true);
			if (!isWindows) {
				expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
			}
		});

		it("does nothing when there is no settings file", async () => {
			rmSync(settingsFile());
			const utils = await load();

			expect(utils.migrateSettingsSecrets()).toBe(false);
		});
	});

	it("without a keyring writes in clear, 0600, and flags it — never silently", async () => {
		fake.state.ready = false;
		const utils = await load();

		utils.writeSettingsFile({ globalOpenAIApiKey: "sk-proj-plain" });

		expect(onDisk().globalOpenAIApiKey).toBe("sk-proj-plain");
		expect(utils.getSecureStorageStatus()).toMatchObject({
			keyringAvailable: false,
			secretsAtRisk: true,
		});
		if (!isWindows) {
			expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
		}
	});

	it("keeps a key it cannot decrypt when the settings are saved again", async () => {
		const blob = fakeEncrypted("sk-ant-locked");
		writeFileSync(
			settingsFile(),
			JSON.stringify({ theme: "dark", globalAnthropicApiKey: blob }),
		);
		fake.state.failDecrypt = true; // keyring locked this session
		const utils = await load();

		const current = utils.readSettingsFile() ?? {};
		utils.writeSettingsFile({ ...current, theme: "light" });

		expect(onDisk()).toEqual({ theme: "light", globalAnthropicApiKey: blob });
	});
});
