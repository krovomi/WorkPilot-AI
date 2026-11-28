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
 *
 * Startup never waits on the keyring. On Linux, libsecret and KWallet hand the
 * key over on the first encryption, and a locked keyring answers with an
 * unlock prompt that may never show (blank under WSLg, absent over SSH): a
 * synchronous call there freezes the main process. So on Linux the sync API is
 * only used once the async probe has answered, and each async call is bounded
 * by KEYRING_TIMEOUT_MS: past it, the session goes on without the keyring
 * (secrets already encrypted are kept as they are, new ones written in clear
 * with the banner). Windows (DPAPI) never prompts; macOS shows its own Keychain
 * dialog the user answers, so neither is bounded.
 *
 * WSL without a usable keyring (none installed, or locked behind a prompt
 * WSLg cannot show) uses Windows DPAPI instead, through interop: a key of the
 * app's own, kept on disk only wrapped by DPAPI (wsl-secret-key.ts), encrypts
 * the secrets as `encw:<base64>` (AES-256-GCM). The banner then has nothing to
 * say. Values already `enc:` keep needing the keyring that wrote them.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { app, safeStorage } from "electron";
import type {
	SecureStorageFix,
	SecureStorageStatus,
} from "../shared/types/ipc";
import { detectWsl } from "./platform/wsl";
import { isLinux } from "./platform";
import { loadWslSecretKey } from "./wsl-secret-key";

export const ENCRYPTED_SECRET_PREFIX = "enc:";
/** AES-256-GCM under the WSL key Windows DPAPI keeps (wsl-secret-key.ts). */
export const APP_KEY_SECRET_PREFIX = "encw:";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

type StatusListener = (status: SecureStorageStatus) => void;

const listeners = new Set<StatusListener>();
/** A secret was read from or written to disk during this session. */
let secretsStored = false;
/** A secret was written in clear because encryption failed or was unavailable. */
let plaintextWritten = false;
let decryptWarned = false;
/** WSL only: the key DPAPI unwrapped for this session; null without one. */
let appKey: Buffer | null = null;
let underWsl: boolean | undefined;
let appKeyPreload: Promise<Buffer | null> | null = null;
/** Rewrites the secrets still in clear (index.ts registers its migration). */
let rewritePlaintextSecrets: () => Promise<void> = async () => {
	// Until index.ts registers the startup migration: nothing to rewrite.
};
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
/** How long a Linux keyring may take to answer before the session goes on without it. */
export const KEYRING_TIMEOUT_MS = 5000;
const TIMED_OUT = Symbol("keyring timed out");
const PROBE_VALUE = "workpilot-keyring-probe";

/**
 * `operation`, raced on Linux against KEYRING_TIMEOUT_MS. Past it, the session
 * stops asking the keyring: its pending call may wait on a prompt forever.
 */
async function bounded<T>(operation: Promise<T>): Promise<T | typeof TIMED_OUT> {
	if (!isLinux()) return operation;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), KEYRING_TIMEOUT_MS);
	});
	try {
		const result = await Promise.race([operation, timeout]);
		if (result === TIMED_OUT) keyringStalled();
		return result;
	} finally {
		clearTimeout(timer);
	}
}

function keyringStalled(): void {
	if (asyncEncryptionAvailable === false) return;
	asyncEncryptionAvailable = false;
	console.warn(
		`[SecretStorage] The OS keyring did not answer within ${KEYRING_TIMEOUT_MS / 1000} s (locked, or its unlock prompt cannot show): this session goes on without it. Secrets already encrypted are kept as they are; unlock the keyring, then restart.`,
	);
}

function remember(ciphertext: string, plaintext: string): void {
	if (decryptedCache.size >= DECRYPTED_CACHE_LIMIT) {
		decryptedCache.clear();
		encryptedCache.clear();
	}
	decryptedCache.set(ciphertext, plaintext);
	encryptedCache.set(plaintext, ciphertext);
}

/** Whether the app is ready; null without an app (tests, a plain Node process). */
function appReady(): boolean | null {
	try {
		return app.isReady();
	} catch {
		return null;
	}
}

/** safeStorage can run at all — enough to decrypt what is already stored. */
function safeStorageReady(): boolean {
	if (asyncEncryptionAvailable !== null) return asyncEncryptionAvailable;
	const ready = appReady();
	// Before `ready` safeStorage cannot decrypt anyway (Linux, Windows); not
	// asking spares the deprecated synchronous probe.
	if (ready === false) return false;
	// Linux, ready but not probed yet: a sync call could wait on an unlock
	// prompt that never shows. Wait for initSecretStorage instead.
	if (ready === true && isLinux()) return false;
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
		const answer = await bounded(
			safeStorage.decryptStringAsync(
				Buffer.from(ciphertext.slice(ENCRYPTED_SECRET_PREFIX.length), "base64"),
			),
		);
		if (answer !== TIMED_OUT) remember(ciphertext, answer.result);
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
	if (selectedBackend() === "basic_text") {
		// No keyring to use (secrets stay in clear, with the banner), but the
		// async API still asks the Secret Service, and a locked one opens an
		// unlock prompt (blank under WSLg) for nothing: do not ask at all.
		asyncEncryptionAvailable = false;
		await loadAppKey();
		publish();
		return;
	}
	try {
		const answer = await bounded(safeStorage.isAsyncEncryptionAvailable());
		if (answer !== TIMED_OUT) asyncEncryptionAvailable = answer;
	} catch {
		asyncEncryptionAvailable = false;
	}
	if (asyncEncryptionAvailable && isLinux()) await probeLinuxKeyring();
	await loadAppKey();
	await primeSecretFiles(files);
	publish();
}

/**
 * WSL: start unwrapping the key already on disk before `ready`, so the second
 * or two PowerShell takes to start runs alongside Electron's own startup
 * instead of delaying the window. Creating one waits for initSecretStorage,
 * which knows whether a keyring can encrypt.
 */
export function preloadAppKey(): void {
	if (!isLinux() || appKeyPreload) return;
	appKeyPreload = loadWslSecretKey({ create: false }).catch(() => null);
}

/**
 * WSL: unwrap the DPAPI-kept key — created when no keyring can encrypt, only
 * read when one can (it still decrypts the `encw:` values written without it).
 * Never throws; elsewhere it does nothing.
 */
async function loadAppKey(): Promise<void> {
	if (!isLinux()) return;
	try {
		const preloaded = appKeyPreload ? await appKeyPreload : null;
		appKeyPreload = null;
		appKey =
			preloaded ?? (await loadWslSecretKey({ create: !keyringAvailable() }));
	} catch {
		appKey = null;
	}
	if (appKey) {
		console.warn(
			"[SecretStorage] No usable Linux keyring under WSL: secrets are encrypted with a key Windows DPAPI keeps for this Windows account.",
		);
	}
}

/** The startup migration, which the banner's retry runs again once it can encrypt. */
export function setPlaintextSecretsRewriter(rewrite: () => Promise<void>): void {
	rewritePlaintextSecrets = rewrite;
}

/**
 * What the banner's button does: under WSL, ask DPAPI again (interop or
 * PowerShell may have been unavailable at launch); elsewhere on Linux the
 * keyring is chosen at launch, so restart. Null when nothing is to fix.
 */
export function secureStorageFix(): SecureStorageFix | null {
	if (!isLinux() || encryptionAvailable()) return null;
	underWsl ??= detectWsl();
	return underWsl ? "retry" : "restart";
}

/**
 * The banner's "retry": load the WSL key again, creating it if need be.
 * When secrets can now be encrypted, those still in clear are rewritten (the
 * startup migration, see setPlaintextSecretsRewriter) and the banner goes away.
 */
export async function retrySecretEncryption(): Promise<boolean> {
	if (!encryptionAvailable()) await loadAppKey();
	if (encryptionAvailable()) {
		await rewritePlaintextSecrets();
		// Rewritten encrypted: what was written in clear no longer is.
		plaintextWritten = false;
	}
	publish();
	return encryptionAvailable();
}

/**
 * libsecret and KWallet hand the key over on the first encryption, which is
 * where a locked keyring prompts. Ask once, bounded, so no sync call ever does.
 */
async function probeLinuxKeyring(): Promise<void> {
	try {
		await bounded(safeStorage.encryptStringAsync(PROBE_VALUE));
	} catch {
		asyncEncryptionAvailable = false; // The keyring refused: no key to use.
	}
}

/**
 * The async safeStorage API may be used: the keyring answered, or there is
 * none to wait on. For callers of their own (server-connection.ts), so they
 * never wait on a keyring that timed out at startup.
 */
export async function asyncEncryptionUsable(): Promise<boolean> {
	if (asyncEncryptionAvailable !== null) return asyncEncryptionAvailable;
	try {
		const answer = await bounded(safeStorage.isAsyncEncryptionAvailable());
		return answer === TIMED_OUT ? false : answer;
	} catch {
		return false;
	}
}

/**
 * safeStorage for a store that calls it synchronously on its own (API
 * Explorer, JEV): it reports no encryption whenever the sync API could wait on
 * the keyring (Linux before the probe, or after a timeout), so the store
 * neither decrypts nor writes there.
 */
export const guardedSafeStorage = {
	isEncryptionAvailable: (): boolean => safeStorageReady(),
	getSelectedStorageBackend: (): string => safeStorage.getSelectedStorageBackend(),
	encryptString: (value: string): Buffer => safeStorage.encryptString(value),
	decryptString: (value: Buffer): string => safeStorage.decryptString(value),
};

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
				const encrypted = await bounded(safeStorage.encryptStringAsync(value));
				if (encrypted === TIMED_OUT) return;
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

/** A new secret can be written encrypted: OS keyring, or the WSL DPAPI key. */
function encryptionAvailable(backend = selectedBackend()): boolean {
	return keyringAvailable(backend) || appKey !== null;
}

function sealWithAppKey(key: Buffer, value: string): string {
	const iv = randomBytes(GCM_IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]);
	return `${APP_KEY_SECRET_PREFIX}${sealed.toString("base64")}`;
}

/** The secret behind an `encw:` value; throws when the key does not open it. */
function openWithAppKey(key: Buffer, stored: string): string {
	const sealed = Buffer.from(
		stored.slice(APP_KEY_SECRET_PREFIX.length),
		"base64",
	);
	if (sealed.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
		throw new Error("truncated value");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		sealed.subarray(0, GCM_IV_BYTES),
	);
	decipher.setAuthTag(
		sealed.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES),
	);
	return Buffer.concat([
		decipher.update(sealed.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)),
		decipher.final(),
	]).toString("utf8");
}

function readableSecretKeys(): string[] {
	return [...new Set([...readableSecrets.values()].flat())].sort();
}

export function getSecureStorageStatus(): SecureStorageStatus {
	const backend = selectedBackend();
	const keyring = keyringAvailable(backend);
	const available = keyring || appKey !== null;
	const readable = readableSecretKeys();
	return {
		keyringAvailable: available,
		protection: keyring ? "os-keyring" : appKey ? "windows-dpapi" : null,
		backend,
		readableSecretKeys: readable,
		secretsAtRisk:
			plaintextWritten || (secretsStored && !available) || readable.length > 0,
		fix: secureStorageFix(),
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
		typeof value === "string" &&
		(value.startsWith(ENCRYPTED_SECRET_PREFIX) ||
			value.startsWith(APP_KEY_SECRET_PREFIX))
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
	if (appKey) return sealWithAppKey(appKey, value);
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
	if (stored.startsWith(APP_KEY_SECRET_PREFIX)) {
		if (!appKey) return undefined;
		try {
			return openWithAppKey(appKey, stored);
		} catch (error) {
			warnUndecryptable(error);
			return undefined;
		}
	}
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
		warnUndecryptable(error);
		return undefined;
	}
}

function warnUndecryptable(error: unknown): void {
	if (decryptWarned) return;
	decryptWarned = true;
	console.warn(
		"[SecretStorage] A stored secret cannot be decrypted; it is kept as is:",
		error,
	);
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
