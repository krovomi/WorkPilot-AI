/**
 * @vitest-environment node
 *
 * The forge accounts saved for the app (forge-accounts.ts): tokens encrypted on
 * disk, never in a view, a token behind the mask kept only for its address,
 * addresses normalized and refused when they carry credentials.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../../../shared/constants/secrets";
import { isWindows } from "../../platform";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${Buffer.from(value).toString("base64")}`,
	decryptSecret: (stored: string) =>
		stored.startsWith("enc:")
			? Buffer.from(stored.slice(4), "base64").toString("utf-8")
			: stored,
}));

import {
	ForgeAccountStore,
	MAX_FORGE_ACCOUNTS,
	forgeAccountStore,
	isForgeKind,
	normalizeForgeHost,
	setForgeAccountStoreForTests,
} from "../forge-accounts";

const TOKEN = "pat-test-0000";

describe("normalizeForgeHost", () => {
	it("gives GitHub and Bitbucket their fixed address, whatever is typed", () => {
		expect(normalizeForgeHost("github", "https://evil.example")).toBe("https://github.com");
		expect(normalizeForgeHost("bitbucket", undefined)).toBe("https://bitbucket.org");
	});

	it("keeps a GitLab instance's origin, gitlab.com by default", () => {
		expect(normalizeForgeHost("gitlab", "")).toBe("https://gitlab.com");
		expect(normalizeForgeHost("gitlab", "gitlab.example.com/some/path")).toBe(
			"https://gitlab.example.com",
		);
		expect(normalizeForgeHost("gitlab", "http://gitlab.local:8080/")).toBe(
			"http://gitlab.local:8080",
		);
	});

	it("reduces an Azure DevOps address to its organization", () => {
		expect(normalizeForgeHost("azure_devops", "https://dev.azure.com/Contoso/Project/_git/r")).toBe(
			"https://dev.azure.com/Contoso",
		);
		expect(normalizeForgeHost("azure_devops", "contoso.visualstudio.com")).toBe(
			"https://contoso.visualstudio.com",
		);
	});

	it.each([
		["gitlab", "https://user:secret@gitlab.example.com"],
		["gitlab", "ftp://gitlab.example.com"],
		["gitlab", "http://"],
		["azure_devops", "http://dev.azure.com/org"],
		["azure_devops", "https://dev.azure.com/"],
		["azure_devops", "https://dev.azure.com/..%2F"],
		["azure_devops", "https://example.com/org"],
		["azure_devops", ""],
	] as const)("refuses %s address %s", (forge, host) => {
		expect(() => normalizeForgeHost(forge, host)).toThrow("Invalid address");
	});

	it("knows its forges", () => {
		expect(isForgeKind("bitbucket")).toBe(true);
		expect(isForgeKind("gitea")).toBe(false);
		expect(isForgeKind(3)).toBe(false);
	});
});

describe("ForgeAccountStore", () => {
	let dir: string;
	let file: string;
	let store: ForgeAccountStore;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "forge-accounts-"));
		file = path.join(dir, "config", "forge-accounts.json");
		store = new ForgeAccountStore(file);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts empty, without a file", () => {
		expect(store.list()).toEqual([]);
		expect(store.tokenOf("nope")).toBeUndefined();
	});

	it("saves an account with its token encrypted and owner-only, the view without it", () => {
		const view = store.save({ forge: "github", label: " Work ", token: TOKEN });
		expect(view).toMatchObject({ forge: "github", label: "Work", host: "https://github.com", hasToken: true });
		expect(view).not.toHaveProperty("token");
		const raw = readFileSync(file, "utf-8");
		expect(raw).not.toContain(TOKEN);
		expect(raw).toContain("enc:");
		if (!isWindows()) expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(store.tokenOf(view.id)).toBe(TOKEN);
		expect(store.get(view.id)).toEqual(view);
	});

	it("keeps the saved token when the mask or nothing comes back, replaces or clears it otherwise", () => {
		const { id } = store.save({ forge: "gitlab", label: "Client", host: "gitlab.example.com", token: TOKEN });
		store.save({ id, forge: "gitlab", label: "Client X", host: "https://gitlab.example.com", token: MASKED_SECRET });
		expect(store.tokenOf(id)).toBe(TOKEN);
		expect(store.get(id)?.label).toBe("Client X");
		store.save({ id, forge: "gitlab", label: "Client X", host: "gitlab.example.com" });
		expect(store.tokenOf(id)).toBe(TOKEN);
		store.save({ id, forge: "gitlab", label: "Client X", host: "gitlab.example.com", token: "pat-test-1111" });
		expect(store.tokenOf(id)).toBe("pat-test-1111");
		store.save({ id, forge: "gitlab", label: "Client X", host: "gitlab.example.com", token: "" });
		expect(store.get(id)?.hasToken).toBe(false);
	});

	it("never sends a kept token to a new address", () => {
		const { id } = store.save({ forge: "gitlab", label: "Client", host: "gitlab.example.com", token: TOKEN });
		expect(() =>
			store.save({ id, forge: "gitlab", label: "Client", host: "https://attacker.example", token: MASKED_SECRET }),
		).toThrow("Enter the token again for the new address");
		expect(store.get(id)?.host).toBe("https://gitlab.example.com");
		// A new token typed for the new address is accepted.
		store.save({ id, forge: "gitlab", label: "Client", host: "https://other.example", token: "pat-test-2222" });
		expect(store.get(id)?.host).toBe("https://other.example");
	});

	it.each([
		[{ forge: "gitea", label: "x" }, "Invalid forge"],
		[{ forge: "github", label: "  " }, "A name is required"],
		[{ forge: "bitbucket", label: "x", username: "a b" }, "Invalid username"],
		[{ forge: "github", label: "x", token: "t".repeat(5000) }, "Token too long"],
		[{ id: "missing", forge: "github", label: "x" }, "Account not found"],
	])("refuses %o", (input, reason) => {
		expect(() => store.save(input as never)).toThrow(reason);
	});

	it("refuses to change an account's forge, and a null input", () => {
		const { id } = store.save({ forge: "github", label: "x" });
		expect(() => store.save({ id, forge: "gitlab", label: "x" })).toThrow("Invalid forge");
		expect(() => store.save(null as never)).toThrow("Invalid forge");
	});

	it("strips control characters from what it keeps", () => {
		const view = store.save({ forge: "github", label: "Wo\u0000rk\u007f\n", token: "pat\u0007-test" });
		expect(view.label).toBe("Work");
		expect(store.tokenOf(view.id)).toBe("pat-test");
	});

	it("caps the number of accounts", () => {
		for (let i = 0; i < MAX_FORGE_ACCOUNTS; i++) store.save({ forge: "github", label: `a${i}` });
		expect(() => store.save({ forge: "github", label: "one more" })).toThrow("Too many accounts");
	});

	it("records a tested login once, and only a plain one", () => {
		const { id } = store.save({ forge: "github", label: "x" });
		store.setUsername(id, "octo-cat");
		expect(store.get(id)?.username).toBe("octo-cat");
		store.setUsername(id, "no spaces allowed");
		store.setUsername("missing", "someone");
		expect(store.get(id)?.username).toBe("octo-cat");
		store.setUsername(id, "octo-cat");
		expect(store.list()).toHaveLength(1);
	});

	it("deletes an account", () => {
		const { id } = store.save({ forge: "github", label: "x" });
		expect(store.delete("missing")).toBe(false);
		expect(store.delete(id)).toBe(true);
		expect(store.list()).toEqual([]);
	});

	it("reads a damaged file as empty and skips malformed entries", () => {
		store.save({ forge: "github", label: "x" });
		writeFileSync(file, "{not json");
		expect(store.list()).toEqual([]);
		writeFileSync(
			file,
			JSON.stringify({ accounts: [{ id: 1 }, { id: "a", forge: "github", label: "ok", host: "https://github.com", createdAt: "" }] }),
		);
		expect(store.list().map((account) => account.id)).toEqual(["a"]);
		writeFileSync(file, JSON.stringify({ accounts: "nope" }));
		expect(store.list()).toEqual([]);
	});
});

describe("forgeAccountStore", () => {
	afterEach(() => setForgeAccountStoreForTests(null));

	it("is one store under the app's user data, replaceable in tests", () => {
		const first = forgeAccountStore();
		expect(forgeAccountStore()).toBe(first);
		const other = new ForgeAccountStore("/tmp/none.json");
		setForgeAccountStoreForTests(other);
		expect(forgeAccountStore()).toBe(other);
	});
});
