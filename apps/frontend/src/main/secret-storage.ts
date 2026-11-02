/**
 * Secrets at rest — the one place the main process turns a credential into
 * what is written to disk, and back. See docs/architecture/secrets-at-rest.md.
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
 *
 * Electron deprecated the synchronous safeStorage calls. The readers and
 * writers here stay synchronous (settings are read on every log line), so the
 * crypto runs ahead of them: `initSecretStorage` probes the keyring and
 * decrypts the secrets already on disk with the async API once `ready` fires,
 * and `prepareSecrets` encrypts a new secret before it is written. The
 * synchronous calls remain only as a fallback for a value neither has seen.
 */

import { readFile } from "node:fs/promises";
import { app, safeStorage } from "electron";
import type { SecureStorageStatus } from "../shared/types/ipc";
import { isLinux } from "./platform";

export const ENCRYPTED_SECRET_PREFIX = "enc:";

type StatusListener = (status: SecureStorageStatus) => void;

const listeners = new Set<StatusListener>();
/** A secret was read from or written to disk during this session. */
let secretsStored = false;
/** A secret was written in clear because encryption failed or was unavailable. */
let plaintextWritten = false;
let decryptWarned = false;
/** File → the secret keys it keeps readable on purpose (names only). */
const readableSecrets = new Map<string, readonly string[]>();
/**
 * Ciphertext → plaintext. Settings are re-read on every log line; this keeps
 * that from costing a DPAPI / keyring round trip per secret each time.
 */
const decryptedCache = new Map<string, string>();
/** Plaintext → the ciphertext already on disk for it, so a rewrite of an
 * unchanged secret does not encrypt it again. */
const encryptedCache = new Map<string, string>();
const DECRYPTED_CACHE_LIMIT = 256;
/** What `isAsyncEncryptionAvailable` answered; null until it has. */
let asyncEncryptionAvailable: boolean | null = null;

function remember(ciphertext: string, plaintext: string): void {
	if (decryptedCache.size >= DECRYPTED_CACHE_LIMIT) {
		decryptedCache.clear();
		encryptedCache.clear();
	}
	decryptedCache.set(ciphertext, plaintext);
	encryptedCache.set(plaintext, ciphertext);
}

function beforeReady(): boolean {
	try {
		return !app.isReady();
	} catch {
		return false; // No app (tests, a plain Node process): just probe.
	}
}

/** safeStorage can run at all — enough to decrypt what is already stored. */
function safeStorageReady(): boolean {
	if (asyncEncryptionAvailable !== null) return asyncEncryptionAvailable;
	// Before `ready` safeStorage cannot decrypt anyway (Linux, Windows); not
	// asking spares the deprecated synchronous probe.
	if (beforeReady()) return false;
	try {
		return safeStorage.isEncryptionAvailable();
	} catch {
		return false;
	}
}

const ENCRYPTED_VALUE = /enc:([A-Za-z0-9+/]+=*)/g;

async function decryptAhead(ciphertext: string): Promise<void> {
	if (decryptedCache.has(ciphertext)) return;
	try {
		const { result } = await safeStorage.decryptStringAsync(
			Buffer.from(ciphertext.slice(ENCRYPTED_SECRET_PREFIX.length), "base64"),
		);
		remember(ciphertext, result);
	} catch {
		// Left to decryptSecret, which keeps the value and warns once.
	}
}

/**
 * Probe the keyring with the async safeStorage API, then decrypt the `enc:`
 * values `files` hold (see primeSecretFiles). Call once `ready` has fired,
 * before anything reads those files.
 */
export async function initSecretStorage(
	files: readonly string[] = [],
): Promise<void> {
	try {
		asyncEncryptionAvailable = await safeStorage.isAsyncEncryptionAvailable();
	} catch {
		asyncEncryptionAvailable = false;
	}
	await primeSecretFiles(files);
	publish();
}

/**
 * Decrypt ahead, with the async safeStorage API, the `enc:` values `files`
 * hold, so their synchronous readers find every secret already decrypted.
 */
export async function primeSecretFiles(files: readonly string[]): Promise<void> {
	if (!asyncEncryptionAvailable) return;
	for (const file of files) {
		let content: string;
		try {
			content = await readFile(file, "utf-8");
		} catch {
			continue; // Not written yet.
		}
		const values = new Set(
			Array.from(content.matchAll(ENCRYPTED_VALUE), (match) => match[0]),
		);
		await Promise.all([...values].map(decryptAhead));
	}
}

/**
 * Encrypt, with the async safeStorage API, the secrets about to be written, so
 * `encryptSecret` finds their ciphertext ready. Values already `enc:`, empty
 * or known are skipped; without a keyring this does nothing.
 */
export async function prepareSecrets(values: Iterable<unknown>): Promise<void> {
	if (!asyncEncryptionAvailable || !keyringAvailable()) return;
	const pending = new Set<string>();
	for (const value of values) {
		if (
			typeof value === "string" &&
			value !== "" &&
			!isEncryptedSecret(value) &&
			!encryptedCache.has(value)
		) {
			pending.add(value);
		}
	}
	await Promise.all(
		[...pending].map(async (value) => {
			try {
				const encrypted = await safeStorage.encryptStringAsync(value);
				remember(
					`${ENCRYPTED_SECRET_PREFIX}${encrypted.toString("base64")}`,
					value,
				);
			} catch {
				// encryptSecret retries synchronously and reports a failure.
			}
		}),
	);
}

/** The values of `record`'s secret fields, for `prepareSecrets`. */
export function secretFieldValues(
	record: object,
	isSecret: (key: string) => boolean,
): unknown[] {
	return Object.entries(record)
		.filter(([key]) => isSecret(key))
		.map(([, value]) => value);
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

function readableSecretKeys(): string[] {
	return [...new Set([...readableSecrets.values()].flat())].sort();
}

export function getSecureStorageStatus(): SecureStorageStatus {
	const backend = selectedBackend();
	const available = keyringAvailable(backend);
	const readable = readableSecretKeys();
	return {
		keyringAvailable: available,
		backend,
		readableSecretKeys: readable,
		secretsAtRisk:
			plaintextWritten || (secretsStored && !available) || readable.length > 0,
	};
}

/**
 * Record the secrets `source` keeps in clear on purpose, because a process
 * that cannot call safeStorage reads them there (a project's `.workpilot/.env`,
 * read by the Python backend). An empty list clears the source. The status
 * names them so the UI warns, keyring or not.
 */
export function setReadableSecrets(
	source: string,
	keys: readonly string[],
): void {
	const before = readableSecretKeys().join("\n");
	if (keys.length > 0) {
		readableSecrets.set(source, [...keys]);
	} else {
		readableSecrets.delete(source);
	}
	if (readableSecretKeys().join("\n") !== before) publish();
}

/**
 * Called with the current status whenever what is on disk may have changed
 * it: the first secret seen this session, the first one written in clear, a
 * change in the secrets kept readable. Returns the unsubscribe.
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
		const known = encryptedCache.get(value);
		if (known !== undefined) return known;
		try {
			const encrypted = `${ENCRYPTED_SECRET_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
			// Only this way round: reading it back still asks the keyring.
			if (encryptedCache.size >= DECRYPTED_CACHE_LIMIT) encryptedCache.clear();
			encryptedCache.set(value, encrypted);
			return encrypted;
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
		remember(stored, secret);
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
