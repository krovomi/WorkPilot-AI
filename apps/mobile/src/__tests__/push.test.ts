import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Api } from "../api/endpoints";
import { cardFromData, easProjectId, registerForPush, unregisterFromPush } from "../push/push";

jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: null } }));
const mockConstants: { expoConfig: { extra?: unknown } | null } = jest.requireMock("expo-constants").default;

function fakeApi() {
	return {
		registerDevice: jest.fn(async () => ({ registered: true })),
		unregisterDevice: jest.fn(async () => ({ removed: true })),
	} as unknown as Api & { registerDevice: jest.Mock; unregisterDevice: jest.Mock };
}

describe("cardFromData", () => {
	it("opens the card a run notification names", () => {
		expect(
			cardFromData({ type: "run_finished", projectId: "3f2a-11", cardId: "012-add-login", phase: "qa" }),
		).toEqual({ projectId: "3f2a-11", cardId: "012-add-login" });
	});

	it.each([
		null,
		"text",
		{ type: "other", projectId: "p", cardId: "001-x" },
		{ type: "run_finished", projectId: "../etc", cardId: "001-x" },
		{ type: "run_finished", projectId: "p", cardId: "../../001" },
		{ type: "run_finished", projectId: "p", cardId: "nope" },
		{ type: "run_finished", projectId: 3, cardId: "001-x" },
	])("ignores anything else: %p", (data) => {
		expect(cardFromData(data)).toBeNull();
	});
});

describe("registration", () => {
	const realOs = Platform.OS;
	beforeEach(() => {
		Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
		mockConstants.expoConfig = { extra: { eas: { projectId: "eas-123" } } };
		jest.clearAllMocks();
	});
	afterAll(() => {
		Object.defineProperty(Platform, "OS", { value: realOs, configurable: true });
	});

	it("reads the EAS project id from the app config", () => {
		expect(easProjectId()).toBe("eas-123");
		mockConstants.expoConfig = { extra: {} };
		expect(easProjectId()).toBeNull();
	});

	it("registers the token with the app's language, then unregisters it on sign-out", async () => {
		const api = fakeApi();
		await expect(registerForPush(api, "fr")).resolves.toBe("ExponentPushToken[testtesttest]");
		expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "eas-123" });
		expect(api.registerDevice).toHaveBeenCalledWith("ExponentPushToken[testtesttest]", "ios", "fr");
		await unregisterFromPush(api);
		expect(api.unregisterDevice).toHaveBeenCalledWith("ExponentPushToken[testtesttest]");
		await unregisterFromPush(api);
		expect(api.unregisterDevice).toHaveBeenCalledTimes(1);
	});

	it("creates the Android channel the server names", async () => {
		Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
		const api = fakeApi();
		await registerForPush(api, "en");
		expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith("runs", expect.anything());
		expect(api.registerDevice).toHaveBeenCalledWith(expect.any(String), "android", "en");
	});

	it("goes without when there is no EAS project", async () => {
		mockConstants.expoConfig = { extra: {} };
		const api = fakeApi();
		await expect(registerForPush(api, "en")).resolves.toBeNull();
		expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
		expect(api.registerDevice).not.toHaveBeenCalled();
	});

	it("goes without on the web", async () => {
		Object.defineProperty(Platform, "OS", { value: "web", configurable: true });
		const api = fakeApi();
		await expect(registerForPush(api, "en")).resolves.toBeNull();
		expect(api.registerDevice).not.toHaveBeenCalled();
	});

	it("goes without when the person refuses", async () => {
		(Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: "undetermined" });
		(Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: "denied" });
		const api = fakeApi();
		await expect(registerForPush(api, "en")).resolves.toBeNull();
		expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
		expect(api.registerDevice).not.toHaveBeenCalled();
	});

	it("never blocks a sign-out on the server's answer", async () => {
		const api = fakeApi();
		await registerForPush(api, "en");
		api.unregisterDevice.mockRejectedValueOnce(new Error("offline"));
		await expect(unregisterFromPush(api)).resolves.toBeUndefined();
	});
});
