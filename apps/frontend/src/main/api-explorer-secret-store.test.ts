import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiExplorerSecretStore } from "./api-explorer-secret-store";

describe("ApiExplorerSecretStore", () => {
	it("writes only OS-encrypted values and restores them by scope", () => {
		const dir = mkdtempSync(join(tmpdir(), "api-explorer-secrets-"));
		const filePath = join(dir, "vault.json");
		const crypto = {
			isEncryptionAvailable: () => true,
			encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
			decryptString: (value: Buffer) =>
				value.toString().replace(/^encrypted:/, ""),
		};
		const store = new ApiExplorerSecretStore(filePath, crypto);

		store.save("project-test::GET:/private", {
			bearer: "super-secret-token",
			password: "super-secret-password",
		});

		const disk = readFileSync(filePath, "utf8");
		expect(disk).not.toContain("super-secret-token");
		expect(disk).not.toContain("super-secret-password");
		expect(store.load("project-test::GET:/private")).toEqual({
			bearer: "super-secret-token",
			password: "super-secret-password",
		});
	});

	it("refuses to persist secrets when OS encryption is unavailable", () => {
		const dir = mkdtempSync(join(tmpdir(), "api-explorer-secrets-"));
		const store = new ApiExplorerSecretStore(join(dir, "vault.json"), {
			isEncryptionAvailable: () => false,
			encryptString: () => Buffer.alloc(0),
			decryptString: () => "",
		});

		expect(() => store.save("scope", { bearer: "secret" })).toThrow(
			"OS encryption is unavailable",
		);
	});
});
