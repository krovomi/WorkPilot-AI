/**
 * A controllable stand-in for Electron's safeStorage. The "ciphertext" is the
 * plaintext XOR-ed byte by byte, so its base64 never contains the secret, and
 * a test can switch the keyring off, select `basic_text`, or make a call throw.
 */

export interface FakeSafeStorageState {
	ready: boolean;
	backend: string;
	failEncrypt: boolean;
	failDecrypt: boolean;
}

const MASK = 0x5a;

function xor(bytes: Buffer): Buffer {
	return Buffer.from(bytes.map((byte) => byte ^ MASK));
}

export function createFakeSafeStorage() {
	const state: FakeSafeStorageState = {
		ready: true,
		backend: "gnome_libsecret",
		failEncrypt: false,
		failDecrypt: false,
	};
	const calls = { encrypt: 0, decrypt: 0 };

	const safeStorage = {
		isEncryptionAvailable: () => state.ready,
		getSelectedStorageBackend: () => state.backend,
		encryptString: (value: string): Buffer => {
			calls.encrypt++;
			if (state.failEncrypt) throw new Error("encryption failed");
			return xor(Buffer.from(value, "utf-8"));
		},
		decryptString: (value: Buffer): string => {
			calls.decrypt++;
			if (state.failDecrypt) throw new Error("decryption failed");
			return xor(value).toString("utf-8");
		},
	};

	const reset = (): void => {
		Object.assign(state, {
			ready: true,
			backend: "gnome_libsecret",
			failEncrypt: false,
			failDecrypt: false,
		});
		calls.encrypt = 0;
		calls.decrypt = 0;
	};

	return { safeStorage, state, calls, reset };
}

export type FakeSafeStorage = ReturnType<typeof createFakeSafeStorage>;

const SHARED = Symbol.for("workpilot.test.fakeSafeStorage");

/**
 * One fake per test file, kept on globalThis so a `vi.mock("electron")`
 * factory re-run by `vi.resetModules()` hands out the instance the test holds.
 */
export function sharedFakeSafeStorage(): FakeSafeStorage {
	const holder = globalThis as unknown as Record<symbol, FakeSafeStorage>;
	holder[SHARED] ??= createFakeSafeStorage();
	return holder[SHARED];
}

/** What `encryptSecret` stores for `value` under the fake keyring. */
export function fakeEncrypted(value: string): string {
	return `enc:${xor(Buffer.from(value, "utf-8")).toString("base64")}`;
}
