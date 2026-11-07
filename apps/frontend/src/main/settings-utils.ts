/**
 * Shared settings utilities for main process
 *
 * This module provides low-level settings file operations used by both
 * the main process startup (index.ts) and the IPC handlers (settings-handlers.ts).
 *
 * NOTE: This module intentionally does NOT perform migrations or auto-detection.
 * Those are handled by the IPC handlers where they have full context.
 * The one exception is migrateSettingsSecrets(): secrets at rest are this
 * module's job, because it is the only reader and writer of the file.
 *
 * Secret fields (see isSecretSettingsKey) are encrypted on write and decrypted
 * on read, so callers only ever see plaintext and the file never holds it
 * unless the OS cannot encrypt — see ./secret-storage. Each secret is dated
 * when its value changes (credentialsSetAt), so the UI can say how old a key is.
 */

import {
	chmodSync,
	existsSync,
	promises as fsPromises,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { app } from "electron";
import { type SecretDates, stampSecretDates } from "../shared/utils/secret-age";
import {
	decryptSecretFields,
	encryptSecretFields,
	hasPlaintextSecretFields,
} from "./secret-storage";

/**
 * Top-level keys holding a credential: the global provider keys and tokens
 * (`globalOpenAIApiKey`, `globalClaudeOAuthToken`, `globalAwsAccessKey`…,
 * including the ones only the provider grid names) and the custom provider key.
 */
const SECRET_SETTINGS_KEY =
	/^(?:global[A-Za-z0-9]*(?:ApiKey|AccessKey|Token|Secret|Password)|customProviderApiKey)$/;

export function isSecretSettingsKey(key: string): boolean {
	return SECRET_SETTINGS_KEY.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSettings(content: string): Record<string, unknown> | undefined {
	const parsed: unknown = JSON.parse(content);
	return isRecord(parsed)
		? decryptSecretFields(parsed, isSecretSettingsKey)
		: (parsed as Record<string, unknown> | undefined);
}

/** Owner read/write only (0600). Best effort: Windows ignores POSIX modes. */
export function restrictToOwner(filePath: string): void {
	try {
		chmodSync(filePath, 0o600);
	} catch {
		// The file stays readable by its previous mode; nothing else to do.
	}
}

/**
 * Get the path to the settings file
 */
export function getSettingsPath(): string {
	return path.join(app.getPath("userData"), "settings.json");
}

/**
 * Read and parse settings from disk.
 * Returns the raw parsed settings object, or undefined if the file doesn't exist or fails to parse.
 * Secret fields come back decrypted.
 *
 * This function does NOT merge with defaults or perform any migrations.
 * Callers are responsible for merging with DEFAULT_APP_SETTINGS.
 */
export function readSettingsFile(): Record<string, unknown> | undefined {
	const settingsPath = getSettingsPath();

	if (!existsSync(settingsPath)) {
		return undefined;
	}

	try {
		const content = readFileSync(settingsPath, "utf-8");
		return decodeSettings(content);
	} catch {
		// Return undefined on parse error - caller will use defaults
		return undefined;
	}
}

/** Key of the secret dates in settings.json; never taken from the caller. */
const CREDENTIALS_SET_AT = "credentialsSetAt";

/**
 * Write settings to disk, secret fields encrypted, file mode 0600.
 * The secret dates are worked out from the file being replaced: whatever
 * `settings` carries under credentialsSetAt is ignored.
 *
 * @param settings - The settings object to write
 * @returns the secret dates written with it
 */
export function writeSettingsFile(settings: object): SecretDates {
	const settingsPath = getSettingsPath();

	// Ensure the directory exists
	const dir = path.dirname(settingsPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const previous = readSettingsFile();
	const { [CREDENTIALS_SET_AT]: _ignored, ...fields } = settings as Record<
		string,
		unknown
	>;
	const dates = stampSecretDates(
		fields,
		previous,
		previous?.[CREDENTIALS_SET_AT],
		isSecretSettingsKey,
	);
	const toWrite =
		Object.keys(dates).length > 0
			? { ...fields, [CREDENTIALS_SET_AT]: dates }
			: fields;
	const content = JSON.stringify(
		encryptSecretFields(toWrite, isSecretSettingsKey),
		null,
		2,
	);
	writeFileSync(settingsPath, content, { encoding: "utf-8", mode: 0o600 });
	restrictToOwner(settingsPath);
	return dates;
}

/**
 * Encrypt the secrets an earlier version wrote in clear, and restrict the file
 * to its owner. Run once the app is ready: safeStorage needs it on Linux and
 * Windows. Without OS encryption the secrets stay in clear and the UI warns.
 * Returns true when the file was rewritten.
 */
export function migrateSettingsSecrets(): boolean {
	const settingsPath = getSettingsPath();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		// No file yet, or one the settings loader will reset to defaults.
		return false;
	}
	if (!isRecord(raw)) return false;

	restrictToOwner(settingsPath);
	if (!hasPlaintextSecretFields(raw, isSecretSettingsKey)) return false;

	writeSettingsFile(decryptSecretFields(raw, isSecretSettingsKey));
	return true;
}

/**
 * Read and parse settings from disk asynchronously.
 * Returns the raw parsed settings object, or undefined if the file doesn't exist or fails to parse.
 * Secret fields come back decrypted.
 *
 * This is the non-blocking version of readSettingsFile, safe to use in Electron main process
 * without blocking the event loop.
 *
 * This function does NOT merge with defaults or perform any migrations.
 * Callers are responsible for merging with DEFAULT_APP_SETTINGS.
 */
export async function readSettingsFileAsync(): Promise<
	Record<string, unknown> | undefined
> {
	const settingsPath = getSettingsPath();

	try {
		await fsPromises.access(settingsPath);
	} catch {
		return undefined;
	}

	try {
		const content = await fsPromises.readFile(settingsPath, "utf-8");
		return decodeSettings(content);
	} catch {
		// Return undefined on parse error - caller will use defaults
		return undefined;
	}
}
