import * as SecureStore from "expo-secure-store";
import { clearSession, loadSession, saveSession } from "../auth/token-store";

describe("token store", () => {
	it("keeps the session in the secure store, this device only", async () => {
		await saveSession({ serverUrl: "https://x.io", refreshToken: "r1", orgId: "o1" });
		expect(await loadSession()).toEqual({ serverUrl: "https://x.io", refreshToken: "r1", orgId: "o1" });
		expect(SecureStore.setItemAsync).toHaveBeenCalledWith("workpilot.refreshToken", "r1", {
			keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
		});
	});

	it("forgets the token and the organization on sign-out, keeps the address", async () => {
		await saveSession({ serverUrl: "https://x.io", refreshToken: "r1", orgId: "o1" });
		await clearSession();
		expect(await loadSession()).toEqual({ serverUrl: "https://x.io", refreshToken: null, orgId: null });
	});

	it("reads an entry the OS can no longer decrypt as no session", async () => {
		(SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error("decrypt"));
		const session = await loadSession();
		expect(session.serverUrl).toBeNull();
	});
});
