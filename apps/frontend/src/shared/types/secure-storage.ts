/**
 * Whether the credentials WorkPilot keeps on disk are protected by the OS.
 * See docs/architecture/secrets-at-rest.md.
 */
export interface SecureStorageStatus {
	/**
	 * Secrets are encrypted with a key the OS keeps (Keychain, DPAPI,
	 * libsecret, KWallet). False when safeStorage cannot encrypt at all, and
	 * on Linux's `basic_text` backend, whose key is compiled into Chromium.
	 */
	keyringAvailable: boolean;
	/** Linux only: the safeStorage backend Electron selected. */
	backend: string | null;
	/**
	 * Names (never values) of the secrets a project's `.workpilot/.env` keeps
	 * in clear on purpose, keyring or not: the Python backend reads them from
	 * that file, in processes that cannot decrypt.
	 */
	readableSecretKeys: string[];
	/**
	 * At least one secret is on disk without keyring protection. The UI warns
	 * while this is true: a secret is never kept in clear without the user
	 * being told.
	 */
	secretsAtRisk: boolean;
}
