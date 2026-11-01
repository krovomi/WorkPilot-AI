// The Keychain / Keystore, in memory: a test reads back what it wrote.
jest.mock("expo-secure-store", () => {
	const store = new Map();
	return {
		AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
		getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
		setItemAsync: jest.fn(async (key, value) => {
			store.set(key, value);
		}),
		deleteItemAsync: jest.fn(async (key) => {
			store.delete(key);
		}),
		__store: store,
	};
});

jest.mock("expo-localization", () => ({
	getLocales: () => [{ languageCode: "en", languageTag: "en-US" }],
}));

// Notifications: no native module under Jest. A test that cares overrides these.
jest.mock("expo-notifications", () => ({
	DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
	AndroidImportance: { DEFAULT: 3 },
	setNotificationHandler: jest.fn(),
	setNotificationChannelAsync: jest.fn(async () => null),
	getPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
	requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
	getExpoPushTokenAsync: jest.fn(async () => ({ type: "expo", data: "ExponentPushToken[testtesttest]" })),
	useLastNotificationResponse: jest.fn(() => null),
	clearLastNotificationResponseAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-device", () => ({ isDevice: true }));
