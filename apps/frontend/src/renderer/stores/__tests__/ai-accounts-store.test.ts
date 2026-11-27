/**
 * The AI accounts store of the renderer: what the main process lists, a
 * refusal kept as a short reason, a list that cannot be read leaving the
 * pages on each provider's main key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiAccountsOf, defaultAiAccountOf, useAiAccountsStore } from "../ai-accounts-store";

const ACCOUNT = { id: "a1", provider: "openai", name: "Perso", hasKey: true, createdAt: "" };
const SNAPSHOT = { accounts: [ACCOUNT], defaults: { openai: "a1" }, mainKeys: ["mistral"] };

const bridge = {
	listAiAccounts: vi.fn(),
	saveAiAccount: vi.fn(),
	deleteAiAccount: vi.fn(),
	testAiAccount: vi.fn(),
	setDefaultAiAccount: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.listAiAccounts.mockResolvedValue({ success: true, data: SNAPSHOT });
	useAiAccountsStore.setState({ accounts: [], defaults: {}, mainKeys: [], loaded: false, error: null });
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("useAiAccountsStore", () => {
	it("loads the accounts, the defaults and the main keys", async () => {
		await useAiAccountsStore.getState().load();
		expect(useAiAccountsStore.getState()).toMatchObject({ ...SNAPSHOT, loaded: true, error: null });
	});

	it("keeps a refusal or a failure as a reason", async () => {
		bridge.listAiAccounts.mockResolvedValueOnce({ success: false, error: "denied" });
		await useAiAccountsStore.getState().load();
		expect(useAiAccountsStore.getState()).toMatchObject({ loaded: true, error: "denied" });
		bridge.listAiAccounts.mockResolvedValueOnce({ success: false });
		await useAiAccountsStore.getState().load();
		expect(useAiAccountsStore.getState().error).toBeNull();
		bridge.listAiAccounts.mockRejectedValueOnce(new Error("no bridge"));
		await useAiAccountsStore.getState().load();
		expect(useAiAccountsStore.getState().error).toBe("no bridge");
		bridge.listAiAccounts.mockRejectedValueOnce("odd");
		await useAiAccountsStore.getState().load();
		expect(useAiAccountsStore.getState().error).toBe("odd");
	});

	it("saves, deletes, tests and sets the default, reloading after a change", async () => {
		const store = useAiAccountsStore.getState();
		bridge.saveAiAccount.mockResolvedValueOnce({ success: true, data: ACCOUNT });
		expect(await store.save({ provider: "openai", name: "Perso", apiKey: "k" })).toEqual({ account: ACCOUNT });
		bridge.saveAiAccount.mockResolvedValueOnce({ success: false, error: "Invalid key" });
		expect(await store.save({ provider: "openai", name: "Perso" })).toEqual({ error: "Invalid key" });

		bridge.deleteAiAccount.mockResolvedValueOnce({ success: true });
		expect(await store.remove("a1")).toBeNull();
		bridge.deleteAiAccount.mockResolvedValueOnce({ success: false, error: "Account not found" });
		expect(await store.remove("a1")).toBe("Account not found");
		bridge.deleteAiAccount.mockResolvedValueOnce({ success: false });
		expect(await store.remove("a1")).toBeNull();

		bridge.testAiAccount.mockResolvedValueOnce({ success: true, data: { ok: true } });
		expect(await store.test("a1")).toEqual({ ok: true });
		bridge.testAiAccount.mockResolvedValueOnce({ success: false, error: "Account not found" });
		expect(await store.test("a1")).toEqual({ ok: false, error: "Account not found" });

		bridge.setDefaultAiAccount.mockResolvedValueOnce({ success: true });
		expect(await store.setDefault("openai", "a1")).toBeNull();
		bridge.setDefaultAiAccount.mockResolvedValueOnce({ success: false, error: "Invalid provider" });
		expect(await store.setDefault("copilot", null)).toBe("Invalid provider");
		bridge.setDefaultAiAccount.mockResolvedValueOnce({ success: false });
		expect(await store.setDefault("openai", null)).toBeNull();
		expect(bridge.listAiAccounts).toHaveBeenCalledTimes(8);
	});

	it("picks a provider's accounts and its default", () => {
		const other = { ...ACCOUNT, id: "b", provider: "mistral" };
		expect(aiAccountsOf([ACCOUNT, other], "mistral")).toEqual([other]);
		expect(defaultAiAccountOf(SNAPSHOT, "openai")).toEqual(ACCOUNT);
		expect(defaultAiAccountOf(SNAPSHOT, "mistral")).toBeUndefined();
	});
});
