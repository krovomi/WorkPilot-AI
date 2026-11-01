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
