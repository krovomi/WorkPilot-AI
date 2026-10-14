/**
 * A project's `.workpilot/.env` — the one module that reads and writes it.
 * See docs/architecture/secrets-at-rest.md.
 *
 * The file holds the project's integration settings and the tokens that go
 * with them (GitHub, GitLab, Linear, Jira, Jenkins, Context7, provider keys).
 * Secrets are encrypted at the file boundary, like settings.json: a secret
 * value is written `enc:<base64>` by secret-storage, or in clear in a 0600
 * file when no OS keyring can encrypt it (the UI then warns). Every caller
 * reads and writes plaintext; Python subprocesses get the decrypted values in
 * their environment, which wins over the file on the backend side.
 *
 * The CLI run without the desktop app cannot decrypt an `enc:` value: it
 * ignores it, says so once, and reads the variable from its own environment.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { getToolPath } from "./cli-tool-manager";
import { parseEnvFile } from "./ipc-handlers/utils";
import { ensureGitignoreEntries } from "./project-initializer";
import {
	decryptSecret,
	encryptSecret,
	isEncryptedSecret,
} from "./secret-storage";

export const DEFAULT_AUTO_BUILD_PATH = ".workpilot";

/**
 * Keys whose value is a credential. A pattern, not a list: integrations add
 * keys (`CICD_GITHUB_TOKEN`, `FIGMA_ACCESS_TOKEN`…) that no type names. A
 * webhook URL embeds its own secret, so it counts. `JIRA_PROJECT_KEY` does
 * not end in one of these and stays readable.
 */
const SECRET_PROJECT_ENV_KEY =
	/(?:_TOKEN|_API_KEY|_ACCESS_KEY|_SECRET_KEY|_SECRET|_PASSWORD|_PAT|_WEBHOOK_URL)$/;
const SECRET_PROJECT_ENV_KEYS = new Set(["DOCINTEL_AZURE_KEY"]);

export function isSecretProjectEnvKey(key: string): boolean {
	return SECRET_PROJECT_ENV_KEY.test(key) || SECRET_PROJECT_ENV_KEYS.has(key);
}

/** `KEY=value`, optionally `export KEY=value`; comments never match. */
const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)(\s*)$/;

function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

/** Rewrites the value of every secret assignment; everything else is kept byte for byte. */
function mapSecretValues(
	content: string,
	transform: (value: string) => string | undefined,
): string {
	return content
		.split(/(\r?\n)/)
		.map((part) => {
			const match = ASSIGNMENT.exec(part);
			if (!match) return part;
			const [, lead, key, eq, rawValue, trail] = match;
			if (!isSecretProjectEnvKey(key)) return part;
			const value = unquote(rawValue);
			if (!value) return part;
			const next = transform(value);
			if (next === undefined || next === value) return part;
			return `${lead}${key}${eq}${next}${trail}`;
		})
		.join("");
}

/** The content to write: secret values encrypted, or kept in clear and the UI told. */
export function encodeProjectEnvContent(content: string): string {
	return mapSecretValues(content, (value) => encryptSecret(value));
}

/**
 * The content callers work with: secret values decrypted. A value that cannot
 * be decrypted right now stays as stored, so writing the content back keeps it.
 */
export function decodeProjectEnvContent(content: string): string {
	return mapSecretValues(content, (value) =>
		isEncryptedSecret(value) ? decryptSecret(value) : value,
	);
}

/** Whether the content holds a secret value still written in clear. */
export function hasPlaintextProjectEnvSecrets(content: string): boolean {
	return Object.entries(parseEnvFile(content)).some(
		([key, value]) =>
			value !== "" && isSecretProjectEnvKey(key) && !isEncryptedSecret(value),
	);
}

export function getProjectEnvPath(
	projectPath: string,
	autoBuildPath?: string | null,
): string {
	return path.join(projectPath, autoBuildPath || DEFAULT_AUTO_BUILD_PATH, ".env");
}

/** Owner read/write only (0600). Best effort: Windows ignores POSIX modes. */
function restrictToOwner(filePath: string): void {
	try {
		chmodSync(filePath, 0o600);
	} catch {
		// The file keeps its previous mode; nothing else to do.
	}
}

/** The file's text with its secrets decrypted; undefined when it does not exist. */
export function readProjectEnvContent(envPath: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(envPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return decodeProjectEnvContent(content);
}

/**
 * The file's variables, secrets decrypted; empty when it does not exist or
 * cannot be read. A secret that cannot be decrypted right now is left out:
 * ciphertext is never a usable token, and handed to a subprocess it would win
 * over the variable the backend would otherwise read.
 */
export function readProjectEnv(envPath: string): Record<string, string> {
	let vars: Record<string, string>;
	try {
		const content = readProjectEnvContent(envPath);
		vars = content === undefined ? {} : parseEnvFile(content);
	} catch {
		return {};
	}
	for (const [key, value] of Object.entries(vars)) {
		if (isSecretProjectEnvKey(key) && isEncryptedSecret(value)) {
			delete vars[key];
		}
	}
	return vars;
}

/** Variables of a project's `.workpilot/.env`, secrets decrypted. */
export function readProjectEnvFor(
	projectPath: string,
	autoBuildPath?: string | null,
): Record<string, string> {
	return readProjectEnv(getProjectEnvPath(projectPath, autoBuildPath));
}

/** Writes `content` with its secrets encrypted, in a file only its owner can read. */
export function writeProjectEnvFile(envPath: string, content: string): void {
	const encoded = encodeProjectEnvContent(content);
	mkdirSync(path.dirname(envPath), { recursive: true });
	writeFileSync(envPath, encoded, { encoding: "utf-8", mode: 0o600 });
	// `mode` only applies when the file is created.
	restrictToOwner(envPath);
}

/**
 * The file must never be committed: it may hold secrets in clear (no keyring)
 * and, encrypted or not, it is machine-local. When git does not ignore it,
 * `.workpilot/` is added to the project's .gitignore — the entry project
 * initialisation adds; a project opened before that ran may lack it.
 * Best effort: no git, or not a repository, leaves things as they are.
 */
export function ensureProjectEnvIgnored(
	projectPath: string,
	envPath: string,
): void {
	if (!existsSync(path.join(projectPath, ".git"))) return;
	const relative = path.relative(projectPath, envPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return;
	try {
		execFileSync(getToolPath("git"), ["check-ignore", "-q", "--", relative], {
			cwd: projectPath,
			stdio: "ignore",
			timeout: 5000,
		});
		return; // exit 0: ignored
	} catch (error) {
		// exit 1: not ignored; anything else (128, spawn failure): unknown.
		if ((error as { status?: number }).status !== 1) return;
	}
	const topDir = relative.split(path.sep)[0];
	try {
		ensureGitignoreEntries(projectPath, [`${topDir}/`]);
		console.warn(
			`[ProjectEnv] ${relative} was not ignored by git: added ${topDir}/ to .gitignore`,
		);
	} catch (error) {
		console.warn("[ProjectEnv] Could not update .gitignore:", error);
	}
}

/** Writes a project's `.workpilot/.env` and makes sure git ignores it. */
export function writeProjectEnv(
	projectPath: string,
	autoBuildPath: string | null | undefined,
	content: string,
): void {
	const envPath = getProjectEnvPath(projectPath, autoBuildPath);
	writeProjectEnvFile(envPath, content);
	ensureProjectEnvIgnored(projectPath, envPath);
}

export interface ProjectEnvLocation {
	path: string;
	autoBuildPath?: string | null;
}

/**
 * Startup migration: restricts every project's `.workpilot/.env` to 0600 and
 * rewrites it when a secret is still in clear. Without a keyring the rewrite
 * keeps the values in clear and raises the banner. Returns how many files
 * were rewritten. Never throws: a project that cannot be migrated is skipped.
 */
export function migrateProjectEnvSecrets(
	projects: readonly ProjectEnvLocation[],
): number {
	let rewritten = 0;
	for (const project of projects) {
		if (!project.autoBuildPath) continue;
		const envPath = getProjectEnvPath(project.path, project.autoBuildPath);
		try {
			if (!existsSync(envPath)) continue;
			restrictToOwner(envPath);
			const content = readFileSync(envPath, "utf-8");
			ensureProjectEnvIgnored(project.path, envPath);
			if (!hasPlaintextProjectEnvSecrets(content)) continue;
			writeProjectEnvFile(envPath, content);
			rewritten++;
		} catch (error) {
			console.warn(`[ProjectEnv] Could not migrate ${envPath}:`, error);
		}
	}
	return rewritten;
}
