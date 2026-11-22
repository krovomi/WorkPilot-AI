/**
 * The bridge forwards the single sign-on request on its own channel, with the
 * server URL only: main reads the provider from the server.
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ ok: true }));
vi.mock("../ipc-utils", () => ({
	invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])),
	createIpcListener: vi.fn(),
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createServerAuthAPI } from "../server-auth-api";

describe("createServerAuthAPI", () => {
	it("invokes the single sign-on channel with the server URL", async () => {
		await createServerAuthAPI().loginSso("https://wp.example.test");
		expect(invokeIpc).toHaveBeenCalledWith(
			IPC_CHANNELS.SERVER_AUTH_LOGIN_SSO,
			"https://wp.example.test",
		);
	});

	it("asks main for the current session with no argument", async () => {
		await createServerAuthAPI().getSession();
		expect(invokeIpc).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_AUTH_GET_SESSION);
	});
});
