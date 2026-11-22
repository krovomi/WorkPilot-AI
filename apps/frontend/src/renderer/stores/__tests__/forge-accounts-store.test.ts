/** @vitest-environment jsdom */
/**
 * The renderer's view of the forge accounts: refusals come back as short
 * reasons, and a list that cannot be read leaves the pages usable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountsOf, useForgeAccountsStore } from "../forge-accounts-store";

const bridge = {
	listForgeAccounts: vi.fn(),
	saveForgeAccount: vi.fn(),
	deleteForgeAccount: vi.fn(),
	testForgeAccount: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.listForgeAccounts.mockResolvedValue({ success: true });
	useForgeAccountsStore.setState({ accounts: [], loaded: false, error: null });
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("forge accounts store", () => {
	it("reads no data as no account, and a refusal or a failure as an error", async () => {
		await useForgeAccountsStore.getState().load();
		expect(useForgeAccountsStore.getState()).toMatchObject({ accounts: [], loaded: true, error: null });
		bridge.listForgeAccounts.mockResolvedValue({ success: false });
		await useForgeAccountsStore.getState().load();
		expect(useForgeAccountsStore.getState().error).toBeNull();
		bridge.listForgeAccounts.mockRejectedValue(new Error("no bridge"));
		await useForgeAccountsStore.getState().load();
		expect(useForgeAccountsStore.getState().error).toBe("no bridge");
		bridge.listForgeAccounts.mockRejectedValue("down");
		await useForgeAccountsStore.getState().load();
		expect(useForgeAccountsStore.getState().error).toBe("down");
	});

	it("passes refusals on", async () => {
		bridge.saveForgeAccount.mockResolvedValue({ success: false, error: "A name is required" });
		expect(await useForgeAccountsStore.getState().save({ forge: "github", label: "" })).toEqual({
			error: "A name is required",
		});
		bridge.deleteForgeAccount.mockResolvedValueOnce({ success: false, error: "Account not found" });
		expect(await useForgeAccountsStore.getState().remove("x")).toBe("Account not found");
		bridge.deleteForgeAccount.mockResolvedValueOnce({ success: false });
		expect(await useForgeAccountsStore.getState().remove("x")).toBeNull();
		bridge.testForgeAccount.mockResolvedValue({ success: false, error: "Invalid account" });
		expect(await useForgeAccountsStore.getState().test("x")).toEqual({ ok: false, error: "Invalid account" });
	});

	it("filters the accounts of one forge", () => {
		const accounts = [
			{ id: "a", forge: "github" as const, label: "a", host: "", hasToken: false, createdAt: "" },
			{ id: "b", forge: "gitlab" as const, label: "b", host: "", hasToken: false, createdAt: "" },
		];
		expect(accountsOf(accounts, "gitlab").map((account) => account.id)).toEqual(["b"]);
	});
});
