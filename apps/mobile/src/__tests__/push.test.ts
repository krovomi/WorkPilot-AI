import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Api } from "../api/endpoints";
import {
	ACTION_APPROVE,
	ACTION_VIEW,
	cardFromData,
	configureCategories,
	easProjectId,
	PLAN_REVIEW,
	registerForPush,
	unregisterFromPush,
} from "../push/push";
import { approveAndBuild, responseAction } from "../push/respond";

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
		).toEqual({ kind: "run_finished", projectId: "3f2a-11", cardId: "012-add-login", specId: null });
	});

	it("knows a plan to approve, and keeps its spec id only when it looks like one", () => {
		expect(
			cardFromData({
				type: "run_finished",
				awaitingApproval: true,
				projectId: "p",
				cardId: "012-add-login",
				specId: "5d1c-77",
			}),
		).toEqual({ kind: "plan_review", projectId: "p", cardId: "012-add-login", specId: "5d1c-77" });
		expect(cardFromData({ type: "run_finished", projectId: "p", cardId: "012-x", specId: "../x" })?.specId).toBeNull();
		expect(cardFromData({ type: "run_finished", awaitingApproval: "yes", projectId: "p", cardId: "012-x" })?.kind).toBe(
			"run_finished",
		);
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

describe("actionable notifications", () => {
	const plan = { kind: "plan_review" as const, projectId: "p", cardId: "012-x", specId: "s1" };
	const run = { ...plan, kind: "run_finished" as const };

	it("registers Approve, behind the device's unlock, and View on a plan to approve", async () => {
		Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
		await configureCategories((key) => `t:${key}`);
		expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalledWith(PLAN_REVIEW, [
			{
				identifier: ACTION_APPROVE,
				buttonTitle: "t:push.approve",
				options: { opensAppToForeground: true, isAuthenticationRequired: true },
			},
			{ identifier: ACTION_VIEW, buttonTitle: "t:push.view", options: { opensAppToForeground: true } },
		]);
	});

	it("opens the card on a tap or View, approves only a plan, ignores the rest", () => {
		expect(responseAction(Notifications.DEFAULT_ACTION_IDENTIFIER, run)).toEqual({ kind: "open", card: run });
		expect(responseAction(ACTION_VIEW, plan)).toEqual({ kind: "open", card: plan });
		expect(responseAction(ACTION_APPROVE, plan)).toEqual({ kind: "approve", card: plan });
		expect(responseAction(ACTION_APPROVE, run)).toEqual({ kind: "ignore" });
		expect(responseAction("other", plan)).toEqual({ kind: "ignore" });
		expect(responseAction(ACTION_VIEW, null)).toEqual({ kind: "ignore" });
	});

	function planApi() {
		return {
			cards: jest.fn(async () => [{ id: "012-x", specId: "s9" }]),
			approve: jest.fn(async () => ({ approved: true })),
			startRun: jest.fn(async () => ({ id: "r1" })),
		} as unknown as Api & { cards: jest.Mock; approve: jest.Mock; startRun: jest.Mock };
	}

	it("approves then builds once the person is recognized", async () => {
		const api = planApi();
		await expect(approveAndBuild(api, plan, async () => true)).resolves.toBe(true);
		expect(api.approve).toHaveBeenCalledWith("p", "012-x");
		expect(api.startRun).toHaveBeenCalledWith("p", "s1", "build");
		expect(api.cards).not.toHaveBeenCalled();
	});

	it("sends nothing when the person cancels the lock", async () => {
		const api = planApi();
		await expect(approveAndBuild(api, plan, async () => false)).resolves.toBe(false);
		expect(api.approve).not.toHaveBeenCalled();
		expect(api.startRun).not.toHaveBeenCalled();
	});

	it("finds the spec id on an older server's notification, and stops when the card is unknown", async () => {
		const api = planApi();
		await approveAndBuild(api, { ...plan, specId: null }, async () => true);
		expect(api.startRun).toHaveBeenCalledWith("p", "s9", "build");
		const missing = planApi();
		await expect(
			approveAndBuild(missing, { ...plan, cardId: "013-y", specId: null }, async () => true),
		).rejects.toThrow("card_not_indexed");
		expect(missing.approve).not.toHaveBeenCalled();
	});
});
