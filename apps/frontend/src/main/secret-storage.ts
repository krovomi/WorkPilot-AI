/**
 * Secrets at rest — the one place the main process turns a credential into
 * what is written to disk, and back. See shared_docs/architecture/secrets-at-rest.md.
 *
 * A stored secret is `enc:<base64>`: Electron safeStorage ciphertext under a
 * key the OS keeps (Keychain, DPAPI, libsecret, KWallet). Without such a key
 * the value is written as is — the caller writes a 0600 file — and the session
 * is flagged so the UI warns the user: a secret is never kept in clear without
 * the user being told. Linux's `basic_text` backend counts as "without": it
 * encrypts with a key compiled into Chromium, which protects nothing. Writing
 * in clear there is what lets the next launch with a keyring encrypt for real.
 *
 * Reading never destroys: a value that cannot be decrypted right now (keyring
 * locked, safeStorage not ready yet) is handed back unchanged by the field
 * helpers, so a later write keeps it instead of replacing the key with nothing.
 */

import { safeStorage } from "electron";
import type { SecureStorageStatus } from "../shared/types/secure-storage";
import { isLinux } from "./platform";

export const ENCRYPTED_SECRET_PREFIX = "enc:";

type StatusListener = (status: SecureStorageStatus) => void;

const listeners = new Set<StatusListener>();
/** A secret was read from or written to disk during this session. */
let secretsStored = false;
/** A secret was written in clear because encryption failed or was unavailable. */
let plaintextWritten = false;
let decryptWarned = false;
/**
 * Ciphertext → plaintext. Settings are re-read on every log line; this keeps
 * that from costing a DPAPI / keyring round trip per secret each time.
 */
const decryptedCache = new Map<string, string>();
const DECRYPTED_CACHE_LIMIT = 256;

/** safeStorage can run at all — enough to decrypt what is already stored. */
function safeStorageReady(): boolean {
	try {
		return safeStorage.isEncryptionAvailable();
	} catch {
		return false;
	}
}

function selectedBackend(): string | null {
	if (!isLinux()) return null;
	try {
		return safeStorage.getSelectedStorageBackend();
	} catch {
		return null;
	}
}

/** safeStorage encrypts under a key the OS keeps — required to encrypt. */
function keyringAvailable(backend = selectedBackend()): boolean {
	return safeStorageReady() && backend !== "basic_text";
}

export function getSecureStorageStatus(): SecureStorageStatus {
	const backend = selectedBackend();
	const available = keyringAvailable(backend);
	return {
		keyringAvailable: available,
		backend,
		secretsAtRisk: plaintextWritten || (secretsStored && !available),
	};
}

/**
 * Called with the current status whenever what is on disk may have changed
 * it: the first secret seen this session, the first one written in clear.
 * Returns the unsubscribe.
 */
export function onSecureStorageStatusChange(
	listener: StatusListener,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function publish(): void {
	const status = getSecureStorageStatus();
	for (const listener of listeners) {
		try {
			listener(status);
		} catch {
			// A listener never breaks a read or a write.
		}
	}
}

function noteSecretStored(): void {
	if (secretsStored) return;
	secretsStored = true;
	publish();
}

function notePlaintextWritten(): void {
	if (plaintextWritten) return;
	plaintextWritten = true;
	console.warn(
		"[SecretStorage] No OS keyring: secrets are written in clear to owner-only (0600) files and the user is warned.",
	);
	publish();
}

export function isEncryptedSecret(value: unknown): value is string {
	return (
		typeof value === "string" && value.startsWith(ENCRYPTED_SECRET_PREFIX)
	);
}

/**
 * The value to write for a secret: `enc:` ciphertext, or the secret itself
 * when no OS keyring can encrypt it — in which case the UI is told.
 * Idempotent: an `enc:` value is returned as is.
 */
export function encryptSecret(value: string): string {
	if (!value || isEncryptedSecret(value)) return value;
	noteSecretStored();
	if (keyringAvailable()) {
		try {
			const encrypted = safeStorage.encryptString(value).toString("base64");
			return `${ENCRYPTED_SECRET_PREFIX}${encrypted}`;
		} catch (error) {
			console.warn("[SecretStorage] safeStorage failed to encrypt:", error);
		}
	}
	notePlaintextWritten();
	return value;
}

/**
 * The secret behind a stored value: legacy plaintext as is, `enc:` decrypted.
 * Undefined when it cannot be decrypted right now — safeStorage not ready
 * (Linux before `ready`), no keyring, or a key the keyring no longer holds.
 */
export function decryptSecret(stored: string): string | undefined {
	if (!stored) return stored;
	noteSecretStored();
	if (!isEncryptedSecret(stored)) return stored;
	const cached = decryptedCache.get(stored);
	if (cached !== undefined) return cached;
	if (!safeStorageReady()) return undefined;
	try {
		const secret = safeStorage.decryptString(
			Buffer.from(stored.slice(ENCRYPTED_SECRET_PREFIX.length), "base64"),
		);
		if (decryptedCache.size >= DECRYPTED_CACHE_LIMIT) decryptedCache.clear();
		decryptedCache.set(stored, secret);
		return secret;
	} catch (error) {
		if (!decryptWarned) {
			decryptWarned = true;
			console.warn(
				"[SecretStorage] A stored secret cannot be decrypted; it is kept as is:",
				error,
			);
		}
		return undefined;
	}
}

type SecretKeyPredicate = (key: string) => boolean;

/** A copy of `record` whose secret fields hold what is written to disk. */
export function encryptSecretFields<T extends object>(
	record: T,
	isSecret: SecretKeyPredicate,
): T {
	const result = { ...record } as Record<string, unknown>;
	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "string" && isSecret(key)) {
			result[key] = encryptSecret(value);
		}
	}
	return result as T;
}

/**
 * A copy of `record` with its secret fields decrypted. A field that cannot be
 * decrypted keeps its stored value, so writing the record back preserves it.
 */
export function decryptSecretFields<T extends object>(
	record: T,
	isSecret: SecretKeyPredicate,
): T {
	const result = { ...record } as Record<string, unknown>;
	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "string" && isSecret(key)) {
			result[key] = decryptSecret(value) ?? value;
		}
	}
	return result as T;
}

/** Whether `record` holds a secret field still written in clear. */
export function hasPlaintextSecretFields(
	record: object,
	isSecret: SecretKeyPredicate,
): boolean {
	return Object.entries(record).some(
		([key, value]) =>
			typeof value === "string" &&
			value !== "" &&
			isSecret(key) &&
			!isEncryptedSecret(value),
	);
}
