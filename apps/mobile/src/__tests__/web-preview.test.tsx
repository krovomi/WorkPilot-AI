/**
 * The web build is a preview, not a shipped target: no secure store, no lock,
 * no push, no share sheet. Each module reads `Platform.OS` when it loads, so
 * each case loads a fresh copy with the platform set first.
 */
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { PushBridge } from "../push/PushBridge";

const { Platform: mainPlatform } = require("react-native");
const realOS = mainPlatform.OS;

/** Some modules read the platform when they load, others on each call: set it for both. */
function onPlatform<T>(os: string, load: () => T): T {
	Object.defineProperty(mainPlatform, "OS", { value: os, configurable: true });
	let loaded!: T;
	jest.isolateModules(() => {
		const { Platform } = require("react-native");
		Object.defineProperty(Platform, "OS", { value: os, configurable: true });
		loaded = load();
	});
	return loaded;
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => Object.defineProperty(mainPlatform, "OS", { value: realOS, configurable: true }));

describe("on the web preview", () => {
	it("keeps no session, and writes nothing", async () => {
		const store = onPlatform("web", () => require("../auth/token-store"));
		await store.saveSession({ serverUrl: "https://x.io", refreshToken: "r", orgId: "o" });
		expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
		expect(await store.loadSession()).toEqual({ serverUrl: null, refreshToken: null, orgId: null });
	});

	it("keeps the theme in the browser's storage", async () => {
		const items = new Map<string, string>();
		const localStorage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v) };
		Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true });
		try {
			const store = onPlatform("web", () => require("../ui/theme-store"));
			expect(await store.loadPrefs()).toBeNull();
			await store.savePrefs({ theme: "dark", colorTheme: "default", pending: true, owner: "u1" });
			expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
			expect(await store.loadPrefs()).toEqual({ theme: "dark", colorTheme: "default", pending: true, owner: "u1" });
		} finally {
			Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
		}
	});

	it("keeps no theme when the browser has no storage", async () => {
		const store = onPlatform("web", () => require("../ui/theme-store"));
		await store.savePrefs({ theme: "dark", colorTheme: "default", pending: false, owner: null });
		expect(await store.loadPrefs()).toBeNull();
	});

	it("keeps no theme when the browser refuses its storage", async () => {
		Object.defineProperty(globalThis, "localStorage", {
			get() {
				throw new Error("SecurityError");
			},
			configurable: true,
		});
		try {
			const store = onPlatform("web", () => require("../ui/theme-store"));
			await store.savePrefs({ theme: "dark", colorTheme: "default", pending: false, owner: null });
			expect(await store.loadPrefs()).toBeNull();
		} finally {
			Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
		}
	});

	it("never locks: default settings, nothing saved, nothing asked", async () => {
		const lock = onPlatform("web", () => require("../auth/lock"));
		await lock.saveLockSettings({ atLaunch: true, sensitive: false });
		expect(await lock.loadLockSettings()).toEqual(lock.DEFAULT_LOCK);
		expect(await lock.canAsk()).toBe(false);
		expect(await lock.authenticate("Unlock", "Cancel")).toBe(true);
		expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
	});

	it("reads no share and sets up no notification", async () => {
		const share = onPlatform("web", () => require("../new-card/incoming"));
		expect(share.readIncomingShare()).toBeNull();
		const push = onPlatform("web", () => require("../push/push"));
		push.configureForeground();
		await push.configureCategories((k: string) => k);
		expect(Notifications.setNotificationHandler).not.toHaveBeenCalled();
		expect(Notifications.setNotificationCategoryAsync).not.toHaveBeenCalled();
		expect(PushBridge()).toBeNull();
	});
});

describe("on a phone", () => {
	it("shows a notification that arrives while the app is open as a silent banner", async () => {
		const push = onPlatform("android", () => require("../push/push"));
		push.configureForeground();
		const [{ handleNotification }] = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0];
		expect(await handleNotification()).toEqual({
			shouldShowBanner: true,
			shouldShowList: true,
			shouldPlaySound: false,
			shouldSetBadge: false,
		});
	});

	it("reads an unreadable lock entry as the defaults", async () => {
		(SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error("keystore"));
		const lock = onPlatform("android", () => require("../auth/lock"));
		expect(await lock.loadLockSettings()).toEqual(lock.DEFAULT_LOCK);
	});

	it("cannot ask when the phone cannot tell its security level", async () => {
		const LocalAuthentication = require("expo-local-authentication");
		(LocalAuthentication.getEnrolledLevelAsync as jest.Mock).mockRejectedValueOnce(new Error("no"));
		const lock = onPlatform("ios", () => require("../auth/lock"));
		expect(await lock.canAsk()).toBe(false);
	});

	it("reads no share when the share sheet fails", () => {
		jest.isolateModules(() => {
			jest.doMock("expo-sharing", () => ({
				getSharedPayloads: () => {
					throw new Error("intent");
				},
				clearSharedPayloads: jest.fn(),
			}));
			const { readIncomingShare } = require("../new-card/incoming");
			expect(readIncomingShare()).toBeNull();
		});
	});
});
