/**
 * @vitest-environment node
 *
 * profiles.json holds every API profile's key. Both profile managers (this
 * service, and utils/profile-manager used by the credential manager) encrypt
 * it on write, decrypt it on read, and migrate files written in clear.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { APIProfile, ProfilesFile } from "@shared/types/profile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../__tests__/helpers/fake-safe-storage";

const paths = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => paths.userData },
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

const fake = sharedFakeSafeStorage();
const isWindows = process.platform === "win32";

function profile(id: string, apiKey: string): APIProfile {
	return {
		id,
		name: `Profile ${id}`,
		baseUrl: "https://api.example.com",
		apiKey,
		createdAt: 1,
		updatedAt: 1,
	};
}

function profilesFile(...profiles: APIProfile[]): ProfilesFile {
	return { profiles, activeProfileId: profiles[0]?.id ?? null, version: 1 };
}

function profilesPath(): string {
	return path.join(paths.userData, "auto-claude", "profiles.json");
}

function onDisk(): ProfilesFile {
	return JSON.parse(readFileSync(profilesPath(), "utf-8"));
}

async function load() {
	vi.resetModules();
	return {
		service: await import("./profile-manager"),
		utils: await import("../../utils/profile-manager"),
		storage: await import("../../secret-storage"),
	};
}

describe("profiles.json secrets", () => {
	beforeEach(() => {
		fake.reset();
		paths.userData = mkdtempSync(path.join(tmpdir(), "profile-secrets-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		rmSync(paths.userData, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("saveProfilesFile writes each apiKey encrypted, loadProfilesFile reads it back", async () => {
		const { service } = await load();

		await service.saveProfilesFile(
			profilesFile(profile("a", "sk-ant-one"), profile("b", "sk-two")),
		);

		expect(readFileSync(profilesPath(), "utf-8")).not.toContain("sk-");
		expect(onDisk().profiles.map((p) => p.apiKey)).toEqual([
			fakeEncrypted("sk-ant-one"),
			fakeEncrypted("sk-two"),
		]);
		const loaded = await service.loadProfilesFile();
		expect(loaded.profiles.map((p) => p.apiKey)).toEqual([
			"sk-ant-one",
			"sk-two",
		]);
		if (!isWindows) {
			expect(statSync(profilesPath()).mode & 0o777).toBe(0o600);
		}
	});

	it("atomicModifyProfiles encrypts on disk and hands the caller plaintext", async () => {
		const { service } = await load();

		const result = await service.atomicModifyProfiles((file) => ({
			...file,
			profiles: [profile("a", "sk-atomic")],
		}));

		expect(result.profiles[0].apiKey).toBe("sk-atomic");
		expect(onDisk().profiles[0].apiKey).toBe(fakeEncrypted("sk-atomic"));
	});

	it("the credential manager's profile manager uses the same encoding", async () => {
		const { utils, service } = await load();

		await utils.saveProfilesFile(profilesFile(profile("a", "sk-utils")));

		expect(onDisk().profiles[0].apiKey).toBe(fakeEncrypted("sk-utils"));
		expect((await utils.loadProfilesFile()).profiles[0].apiKey).toBe(
			"sk-utils",
		);
		expect((await service.loadProfilesFile()).profiles[0].apiKey).toBe(
			"sk-utils",
		);
	});

	describe("migration of a file written in clear", () => {
		beforeEach(() => {
			mkdirSync(path.dirname(profilesPath()), { recursive: true });
			writeFileSync(
				profilesPath(),
				JSON.stringify(profilesFile(profile("a", "sk-legacy"))),
				{ mode: 0o644 },
			);
		});

		it("encrypts the legacy keys", async () => {
			const { service } = await load();

			expect(await service.migrateProfilesSecrets()).toBe(true);

			expect(onDisk().profiles[0]).toEqual(
				profile("a", fakeEncrypted("sk-legacy")),
			);
			expect((await service.loadProfilesFile()).profiles[0].apiKey).toBe(
				"sk-legacy",
			);
			expect(await service.migrateProfilesSecrets()).toBe(false);
		});

		it("without a keyring keeps them in clear and flags them for the UI", async () => {
			fake.state.ready = false;
			const { service, storage } = await load();

			await service.migrateProfilesSecrets();

			expect(onDisk().profiles[0].apiKey).toBe("sk-legacy");
			expect(storage.getSecureStorageStatus().secretsAtRisk).toBe(true);
			if (!isWindows) {
				expect(statSync(profilesPath()).mode & 0o777).toBe(0o600);
			}
		});
	});

	it("never turns a key it cannot decrypt into an empty one", async () => {
		// An empty apiKey reads as a placeholder, and the credential manager
		// deletes placeholder profiles on startup.
		const blob = fakeEncrypted("sk-locked");
		mkdirSync(path.dirname(profilesPath()), { recursive: true });
		writeFileSync(profilesPath(), JSON.stringify(profilesFile(profile("a", blob))));
		fake.state.failDecrypt = true;
		const { service } = await load();

		const loaded = await service.loadProfilesFile();
		expect(loaded.profiles[0].apiKey).toBe(blob);

		await service.saveProfilesFile(loaded);
		expect(onDisk().profiles[0].apiKey).toBe(blob);
	});
});
