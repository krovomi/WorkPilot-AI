/**
 * The AI accounts bridge: a CLI account's sign-in names the account id only,
 * on its own channel; the command and folder come back from the main process.
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ success: false, error: "Account not found" })));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createAiAccountsAPI } from "../ai-accounts-api";

describe("createAiAccountsAPI", () => {
	it("asks for a CLI account's sign-in by id", async () => {
		expect(await createAiAccountsAPI().signInAiAccount("a1")).toEqual({
			success: false,
			error: "Account not found",
		});
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.AI_ACCOUNTS_SIGN_IN, "a1");
	});
});
