/**
 * @vitest-environment node
 *
 * Claude profile OAuth tokens: same policy as every other secret at rest.
 * Before, encryptToken fell back to the raw token without telling anyone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../__tests__/helpers/fake-safe-storage";

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return { safeStorage: sharedFakeSafeStorage().safeStorage };
});

const fake = sharedFakeSafeStorage();

async function load() {
	vi.resetModules();
	return {
		tokens: await import("../token-encryption"),
		storage: await import("../../secret-storage"),
	};
}

describe("token-encryption", () => {
	beforeEach(() => {
		fake.reset();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("encrypts with the enc: prefix and decrypts back", async () => {
		const { tokens } = await load();

		const stored = tokens.encryptToken("sk-ant-oat01-token");

		expect(stored).toBe(fakeEncrypted("sk-ant-oat01-token"));
		expect(tokens.isTokenEncrypted(stored)).toBe(true);
		expect(tokens.decryptToken(stored)).toBe("sk-ant-oat01-token");
	});

	it("without a keyring keeps the raw token and flags it — no silent fallback", async () => {
		fake.state.ready = false;
		const { tokens, storage } = await load();

		expect(tokens.encryptToken("sk-ant-oat01-token")).toBe("sk-ant-oat01-token");
		expect(storage.getSecureStorageStatus().secretsAtRisk).toBe(true);
	});

	it("returns an empty token, not the ciphertext, when it cannot decrypt", async () => {
		fake.state.ready = false;
		const { tokens } = await load();

		expect(tokens.decryptToken(fakeEncrypted("sk-ant-oat01-token"))).toBe("");
	});

	it("still reads tokens stored in clear by older versions", async () => {
		const { tokens } = await load();

		expect(tokens.decryptToken("sk-ant-oat01-legacy")).toBe(
			"sk-ant-oat01-legacy",
		);
		expect(tokens.isTokenEncrypted("sk-ant-oat01-legacy")).toBe(false);
	});
});
