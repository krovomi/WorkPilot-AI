/**
 * @vitest-environment node
 *
 * IPC of the forge accounts (forge-accounts-handlers.ts): the renderer's
 * arguments are rechecked, a token never comes back, a tested login is kept
 * except for Bitbucket, whose username signs in.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
	app: { getPath: () => "/unused" },
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
	},
}));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${value}`,
	decryptSecret: (stored: string) => stored.replace(/^enc:/, ""),
	prepareSecrets: (values: unknown) => prepareSecrets(values),
}));
const prepareSecrets = vi.fn(async (_values: unknown) => undefined);
const testForgeAccount = vi.fn();
vi.mock("../../forge/forge-account-test", () => ({
	testForgeAccount: (...args: unknown[]) => testForgeAccount(...args),
}));

import { ForgeAccountStore, setForgeAccountStoreForTests } from "../../forge/forge-accounts";
import { registerForgeAccountsHandlers } from "../forge-accounts-handlers";

function call(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args);
}

describe("forge accounts IPC", () => {
	let dir: string;
	let store: ForgeAccountStore;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "forge-ipc-"));
		store = new ForgeAccountStore(path.join(dir, "forge-accounts.json"));
		setForgeAccountStoreForTests(store);
		handlers.clear();
		testForgeAccount.mockReset();
		registerForgeAccountsHandlers();
	});

	afterEach(() => {
		setForgeAccountStoreForTests(null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("saves, lists and deletes an account; the token never comes back", async () => {
		const saved = (await call(IPC_CHANNELS.FORGE_ACCOUNTS_SAVE, {
			forge: "github",
			label: "Work",
			token: "pat-test-0000",
		})) as { success: boolean; data: { id: string } };
		expect(saved.success).toBe(true);
		expect(prepareSecrets).toHaveBeenCalledWith(["pat-test-0000"]);
		const listed = await call(IPC_CHANNELS.FORGE_ACCOUNTS_LIST);
		expect(JSON.stringify(listed)).not.toContain("pat-test-0000");
		expect(listed).toMatchObject({ success: true, data: [{ label: "Work", hasToken: true }] });
		expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_DELETE, saved.data.id)).toEqual({ success: true });
		expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_DELETE, saved.data.id)).toEqual({
			success: false,
			error: "Account not found",
		});
	});

	it.each([[null], ["text"], [{ id: 3, forge: "github", label: "x" }], [{ id: "x".repeat(65), forge: "github", label: "x" }]])(
		"refuses an account like %o",
		async (input) => {
			expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_SAVE, input)).toEqual({ success: false, error: "Invalid account" });
		},
	);

	it("passes the store's refusal on", async () => {
		expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_SAVE, { forge: "gitlab", label: "x", host: "ftp://h" })).toEqual({
			success: false,
			error: "Invalid address",
		});
	});

	it.each([[undefined], [""], [42], ["x".repeat(65)]])("refuses the id %o", async (id) => {
		expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_DELETE, id)).toEqual({ success: false, error: "Invalid account" });
		expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_TEST, id)).toEqual({ success: false, error: "Invalid account" });
	});

	it("tests with the stored token and keeps the login it answered", async () => {
		const { id } = store.save({ forge: "gitlab", label: "x", token: "pat-test-0000" });
		testForgeAccount.mockResolvedValue({ ok: true, username: "gl-user" });
		expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_TEST, id)).toEqual({
			success: true,
			data: { ok: true, username: "gl-user" },
		});
		expect(testForgeAccount).toHaveBeenCalledWith(expect.objectContaining({ id }), "pat-test-0000");
		expect(store.get(id)?.username).toBe("gl-user");
		expect(await call(IPC_CHANNELS.FORGE_ACCOUNTS_TEST, "missing")).toEqual({
			success: false,
			error: "Account not found",
		});
	});

	it("keeps a Bitbucket username as typed", async () => {
		const { id } = store.save({ forge: "bitbucket", label: "x", username: "me@example.com", token: "pat-test-0000" });
		testForgeAccount.mockResolvedValue({ ok: true, username: "nick" });
		await call(IPC_CHANNELS.FORGE_ACCOUNTS_TEST, id);
		expect(store.get(id)?.username).toBe("me@example.com");
		testForgeAccount.mockResolvedValue({ ok: false, error: "Token refused" });
		const gh = store.save({ forge: "github", label: "y", token: "pat-test-0000" });
		await call(IPC_CHANNELS.FORGE_ACCOUNTS_TEST, gh.id);
		expect(store.get(gh.id)?.username).toBeUndefined();
	});
});
