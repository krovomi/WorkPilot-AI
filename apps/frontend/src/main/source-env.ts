/**
 * The backend's own `.env`, which the IPC calls the source env: the Claude
 * token the environment dialog saves (AUTOBUILD_SOURCE_ENV_UPDATE), next to
 * whatever else the file already held. See docs/architecture/secrets-at-rest.md.
 *
 * Who reads the file decides what a secret looks like in it:
 * - Running from source, it is `apps/backend/.env`, which Python loads itself
 *   with python-dotenv (`runners/github/runner.py`, `runners/gitlab/runner.py`,
 *   `provider_api.py` run directly). Python cannot call safeStorage, so the
 *   secrets stay in clear: the file is 0600 and its secret keys are reported
 *   to secret-storage (setReadableSecrets), so the UI names them.
 * - Packaged, it is `<userData>/backend/.env`, which no Python code knows:
 *   only the main process reads it. Its secrets are `enc:`, like those of
 *   settings.json, or in clear in a 0600 file with the warning when no OS
 *   keyring can encrypt them.
 *
 * Whoever builds a backend subprocess's environment reads it through
 * loadBackendEnv, which decrypts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { isSensitiveKey } from "../shared/utils/secret-redaction";
import { parseEnvFile } from "./ipc-handlers/utils";
import {
	decryptSecret,
	encryptSecretFields,
	isEncryptedSecret,
	setReadableSecrets,
} from "./secret-storage";
import { restrictToOwner } from "./settings-utils";

export const SOURCE_ENV_TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

export interface SourceEnvFile {
	envPath: string;
	/** Python loads the file itself (running from source): no `enc:` in it. */
	readByBackend: boolean;
}

/**
 * Packaged, where the UI saves the source env: the bundled backend sits in
 * read-only resources, and its own `.env` is left out of the bundle.
 */
export function getPackagedSourceEnvPath(): string {
	return path.join(app.getPath("userData"), "backend", ".env");
}

/** `AZURE_DEVOPS_PAT`: a credential the generic key pattern does not name. */
const PERSONAL_ACCESS_TOKEN = /(?:^|_)PAT$/i;

/** A variable holding a credential: `CLAUDE_CODE_OAUTH_TOKEN`, `…_API_KEY`… */
export function isSourceEnvSecretKey(key: string): boolean {
	return isSensitiveKey(key) || PERSONAL_ACCESS_TOKEN.test(key);
}

/** The secret keys `vars` holds in clear (names only). */
function plaintextSecretKeys(vars: Record<string, string>): string[] {
	return Object.entries(vars)
		.filter(
			([key, value]) =>
				value !== "" && isSourceEnvSecretKey(key) && !isEncryptedSecret(value),
		)
		.map(([key]) => key);
}

function formatSourceEnv(vars: Record<string, string>): string {
	const lines: string[] = [
		"# WorkPilot AI Framework Environment Variables",
		"# Managed by WorkPilot AI UI",
		"",
		"# Claude Code OAuth Token (REQUIRED)",
		`${SOURCE_ENV_TOKEN_KEY}=${vars[SOURCE_ENV_TOKEN_KEY] || ""}`,
		"",
	];
	// Preserve the other variables the file held
	for (const [key, value] of Object.entries(vars)) {
		if (key !== SOURCE_ENV_TOKEN_KEY) {
			lines.push(`${key}=${value}`);
		}
	}
	return lines.join("\n");
}

/**
 * Write the file, owner-only. Its secrets are encrypted unless Python reads
 * it, in which case they stay in clear and their keys are reported so the UI
 * warns. `vars` may mix plaintext and values already `enc:`.
 */
export function writeSourceEnvFile(
	file: SourceEnvFile,
	vars: Record<string, string>,
): void {
	const stored = file.readByBackend
		? vars
		: encryptSecretFields(vars, isSourceEnvSecretKey);
	writeFileSync(file.envPath, formatSourceEnv(stored), {
		encoding: "utf-8",
		mode: 0o600,
	});
	// `mode` only applies when the file is created
	restrictToOwner(file.envPath);
	if (file.readByBackend) {
		setReadableSecrets(file.envPath, plaintextSecretKeys(stored));
	}
}

/**
 * Bring a file an earlier version wrote up to date. Run once the app is
 * ready, as safeStorage needs it on Linux and Windows. The file is restricted
 * to its owner. Where only the main process reads it, the secrets still in
 * clear are encrypted (or stay in clear with the warning when no keyring can
 * encrypt them); where Python reads it, its secret keys are reported so the
 * UI warns. Returns true when the file was rewritten.
 */
export function migrateSourceEnvSecrets(file: SourceEnvFile): boolean {
	let vars: Record<string, string>;
	try {
		vars = parseEnvFile(readFileSync(file.envPath, "utf-8"));
	} catch {
		// No file yet: the first save creates it 0600.
		return false;
	}

	restrictToOwner(file.envPath);
	const plaintextKeys = plaintextSecretKeys(vars);
	if (file.readByBackend) {
		setReadableSecrets(file.envPath, plaintextKeys);
		return false;
	}
	if (plaintextKeys.length === 0) return false;

	writeSourceEnvFile(file, vars);
	return true;
}

/** The variables of an env file with a value; none when it cannot be read. */
function readEnvValues(envPath: string): Record<string, string> {
	if (!existsSync(envPath)) return {};
	try {
		const values: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			parseEnvFile(readFileSync(envPath, "utf-8")),
		)) {
			// An empty line (`CLAUDE_CODE_OAUTH_TOKEN=`) sets nothing: it must not
			// mask a value another layer provides.
			if (value) values[key] = value;
		}
		return values;
	} catch {
		return {};
	}
}

/**
 * What a backend subprocess gets from the `.env` files: the backend source's
 * own, then, packaged, the copy the UI saves under userData, which wins. Its
 * secrets come back decrypted. One the keyring cannot decrypt right now is
 * left out, never handed to Python as ciphertext: the profile token, layered
 * after this by every caller, stands in.
 */
export function loadBackendEnv(autoBuildSource: string): Record<string, string> {
	const env = {
		...readEnvValues(path.join(autoBuildSource, ".env")),
		...(app.isPackaged ? readEnvValues(getPackagedSourceEnvPath()) : {}),
	};
	for (const [key, value] of Object.entries(env)) {
		if (!isSourceEnvSecretKey(key) || !isEncryptedSecret(value)) continue;
		const secret = decryptSecret(value);
		if (secret) {
			env[key] = secret;
		} else {
			delete env[key];
		}
	}
	return env;
}
