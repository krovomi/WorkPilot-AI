import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JevSecretStore } from "./secret-store";

const dirs: string[] = [];
function setup(backend = "libsecret", available = true) {
	const dir = mkdtempSync(join(tmpdir(), "jev-test-"));
	dirs.push(dir);
	const crypto = {
		isEncryptionAvailable: () => available,
		getSelectedStorageBackend: () => backend,
		encryptString: (value: string) =>
			Buffer.from(value.split("").reverse().join("")),
		decryptString: (value: Buffer) =>
			value.toString().split("").reverse().join(""),
	};
	return {
		store: new JevSecretStore(join(dir, "jev.json"), crypto),
		path: join(dir, "jev.json"),
		crypto,
	};
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
describe("JEV secret storage", () => {
	it("roundtrips an encrypted key without exposing it in status", () => {
		const { store, path } = setup();
		store.save("test-secret");
		expect(store.read()).toBe("test-secret");
		expect(readFileSync(path, "utf8")).not.toContain("test-secret");
		expect(store.getStatus()).toEqual({
			configured: true,
			secureStorageAvailable: true,
		});
		store.clear();
		store.clear();
		expect(store.read()).toBeUndefined();
	});
	it.each([
		["basic_text", true],
		["libsecret", false],
	] as const)("rejects insecure storage %s", (backend, available) => {
		const { store } = setup(backend, available);
		expect(() => store.save("test-secret")).toThrow("jev-storage-unavailable");
		expect(store.read()).toBeUndefined();
	});
	it("allows deletion even when decryption fails", () => {
		const { store, crypto } = setup();
		store.save("old-key");
		vi.spyOn(crypto, "decryptString").mockImplementation(() => {
			throw new Error("private");
		});
		expect(store.getStatus().configured).toBe(false);
		store.clear();
		expect(store.read()).toBeUndefined();
	});
	it.each([
		"",
		"  ",
		"key\nInjected",
		"x".repeat(4097),
	])("rejects invalid keys", (key) => {
		expect(() => setup().store.save(key)).toThrow("jev-invalid-key");
	});
});
