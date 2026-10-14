/**
 * The backend's own `.env`, which the IPC calls the source env: the Claude
 * token the environment dialog saves (AUTOBUILD_SOURCE_ENV_UPDATE), next to
 * whatever else the file already held. See docs/architecture/secrets-at-rest.md.
 *
 * Who reads the file decides what a secret looks like in it:
 * - Running from source, it is `apps/backend/.env`, which Python loads itself
 *   with python-dotenv (`runners/github/runner.py`, `runners/gitlab/runner.py`,
 *   `provider_api.py` run directly). Python cannot call safeStorage, so the
 *   secrets stay in clear: the file is 0600 and reported to secret-storage,
 *   and the UI names it while it holds one.
 * - Packaged, it is `<userData>/backend/.env`, which no Python code knows:
 *   only the main process reads it. Its secrets are `enc:`, like those of
 *   settings.json, or in clear in a 0600 file with the warning when no OS
 *   keyring can encrypt them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isSensitiveKey } from "../shared/utils/secret-redaction";
import { parseEnvFile } from "./ipc-handlers/utils";
import {
	encryptSecretFields,
	hasPlaintextSecretFields,
	reportPlaintextSecretFile,
} from "./secret-storage";
import { restrictToOwner } from "./settings-utils";

export const SOURCE_ENV_TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

export interface SourceEnvFile {
	envPath: string;
	/** Python loads the file itself (running from source): no `enc:` in it. */
	readByBackend: boolean;
}

/** `AZURE_DEVOPS_PAT`: a credential the generic key pattern does not name. */
const PERSONAL_ACCESS_TOKEN = /(?:^|_)PAT$/i;

/** A variable holding a credential: `CLAUDE_CODE_OAUTH_TOKEN`, `…_API_KEY`… */
export function isSourceEnvSecretKey(key: string): boolean {
	return isSensitiveKey(key) || PERSONAL_ACCESS_TOKEN.test(key);
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
 * it, in which case they stay in clear and the file is reported so the UI
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
		reportPlaintextSecretFile(
			file.envPath,
			hasPlaintextSecretFields(stored, isSourceEnvSecretKey),
		);
	}
}

/**
 * Bring a file an earlier version wrote up to date. Run once the app is
 * ready, as safeStorage needs it on Linux and Windows. The file is restricted
 * to its owner. Where only the main process reads it, the secrets still in
 * clear are encrypted (or stay in clear with the warning when no keyring can
 * encrypt them); where Python reads it, its secrets are reported so the UI
 * warns. Returns true when the file was rewritten.
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
	const plaintextSecrets = hasPlaintextSecretFields(
		vars,
		isSourceEnvSecretKey,
	);
	if (file.readByBackend) {
		reportPlaintextSecretFile(file.envPath, plaintextSecrets);
		return false;
	}
	if (!plaintextSecrets) return false;

	writeSourceEnvFile(file, vars);
	return true;
}
