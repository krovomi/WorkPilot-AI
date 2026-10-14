/**
 * A project's `.workpilot/.env` — the one place the main process reads and
 * writes it. See docs/architecture/secrets-at-rest.md.
 *
 * The Python backend reads this file with its own parsers and cannot call
 * safeStorage, so its secrets come in two kinds
 * (shared/constants/project-env-secrets.json):
 *
 * - `encrypted`: Python only gets them from its environment, which the main
 *   process builds from this file. They are stored `enc:` like the keys of
 *   settings.json, and decrypted here whenever the file is read.
 * - `readable`: the backend reads them from the file itself, in processes the
 *   app starts without the project's environment (the API server, the PR
 *   review runners). Ciphertext there would break Figma import, notifications,
 *   Context7 and custom MCP servers, so they stay in clear — in a 0600 file,
 *   and named by the status the sidebar banner reads.
 *
 * Every other line is written back byte for byte: comments, order, and the
 * keys this module knows nothing about.
 */

import { chmodSync, mkdirSync, promises as fsPromises, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import projectEnvSecrets from "../shared/constants/project-env-secrets.json";
import {
	decryptSecret,
	encryptSecret,
	isEncryptedSecret,
	setReadableSecrets,
} from "./secret-storage";

export const ENCRYPTED_PROJECT_ENV_KEYS: ReadonlySet<string> = new Set(
	projectEnvSecrets.encrypted,
);
export const READABLE_PROJECT_ENV_SECRET_KEYS: ReadonlySet<string> = new Set(
	projectEnvSecrets.readable,
);

/** Configuration, except for the HTTP headers where a bearer token goes. */
const CUSTOM_MCP_SERVERS_KEY = "CUSTOM_MCP_SERVERS";

interface ProjectLocation {
	path: string;
	autoBuildPath?: string | null;
}

interface EnvEntry {
	key: string;
	value: string;
	/** Index of the `=` in the line, to rewrite the value and keep the rest. */
	equalsIndex: number;
}

/** `<project>/<autoBuildPath>/.env`, or null for a project not initialized. */
export function getProjectEnvPath(project: ProjectLocation): string | null {
	if (!project.autoBuildPath) return null;
	return path.join(project.path, project.autoBuildPath, ".env");
}

/** Same reading as `parseEnvFile`: `KEY=value`, one pair of quotes removed. */
function parseLine(line: string): EnvEntry | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return null;
	const equalsIndex = line.indexOf("=");
	if (equalsIndex <= 0) return null;
	const key = line.slice(0, equalsIndex).trim();
	if (!key) return null;
	let value = line.slice(equalsIndex + 1).trim();
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")))
	) {
		value = value.slice(1, -1);
	}
	return { key, value, equalsIndex };
}

function rawEntries(content: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const entry = parseLine(line);
		if (entry) vars[entry.key] = entry.value;
	}
	return vars;
}

/**
 * The variables of a `.env` content, `enc:` values decrypted. A value that
 * cannot be decrypted right now (keyring locked, another machine's
 * ciphertext) is left out: a subprocess or an API call gets no token rather
 * than ciphertext, and the file keeps it for a launch that can read it.
 */
export function parseProjectEnv(content: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawEntries(content))) {
		if (!isEncryptedSecret(value)) {
			vars[key] = value;
			continue;
		}
		const secret = decryptSecret(value);
		if (secret !== undefined) vars[key] = secret;
	}
	return vars;
}

/** A project `.env` read and decrypted; `{}` when missing or unreadable. */
export function readProjectEnvFile(envPath: string): Record<string, string> {
	try {
		return parseProjectEnv(readFileSync(envPath, "utf-8"));
	} catch {
		return {};
	}
}

/** `readProjectEnvFile`, without blocking the main process. */
export async function readProjectEnvFileAsync(
	envPath: string,
): Promise<Record<string, string>> {
	try {
		return parseProjectEnv(await fsPromises.readFile(envPath, "utf-8"));
	} catch {
		return {};
	}
}

/** A project's `.env`, decrypted; `{}` when the project has none. */
export function readProjectEnv(
	project: ProjectLocation,
): Record<string, string> {
	const envPath = getProjectEnvPath(project);
	return envPath ? readProjectEnvFile(envPath) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function holdsSecret(key: string, value: string): boolean {
	if (!value.trim()) return false;
	if (key !== CUSTOM_MCP_SERVERS_KEY) return true;
	try {
		const servers: unknown = JSON.parse(value);
		return (
			Array.isArray(servers) &&
			servers.some(
				(server) =>
					isRecord(server) &&
					isRecord(server.headers) &&
					Object.values(server.headers).some(
						(header) => typeof header === "string" && header.trim() !== "",
					),
			)
		);
	} catch {
		return false;
	}
}

/** Names of the `readable` secrets a `.env` content sets — never values. */
export function readableSecretKeysOf(content: string): string[] {
	return Object.entries(rawEntries(content))
		.filter(
			([key, value]) =>
				READABLE_PROJECT_ENV_SECRET_KEYS.has(key) && holdsSecret(key, value),
		)
		.map(([key]) => key)
		.sort();
}

function holdsPlaintextEncryptedKey(content: string): boolean {
	return Object.entries(rawEntries(content)).some(
		([key, value]) =>
			ENCRYPTED_PROJECT_ENV_KEYS.has(key) &&
			value !== "" &&
			!isEncryptedSecret(value),
	);
}

/**
 * `content` as written to disk: each `encrypted` key's value through
 * `encryptSecret` (idempotent on `enc:`; in clear only when no OS keyring can
 * encrypt, and then the UI is told). Every other line is kept as is.
 */
export function encodeProjectEnvContent(content: string): string {
	return content
		.split(/(\r?\n)/)
		.map((segment) => {
			const entry = parseLine(segment);
			if (
				!entry ||
				!ENCRYPTED_PROJECT_ENV_KEYS.has(entry.key) ||
				entry.value === "" ||
				isEncryptedSecret(entry.value)
			) {
				return segment;
			}
			const stored = encryptSecret(entry.value);
			// No keyring: the line stays exactly as it was, quotes included.
			if (stored === entry.value) return segment;
			return `${segment.slice(0, entry.equalsIndex + 1)}${stored}`;
		})
		.join("");
}

/** Owner read/write only (0600). Best effort: Windows ignores POSIX modes. */
function restrictToOwner(filePath: string): void {
	try {
		chmodSync(filePath, 0o600);
	} catch {
		// The file keeps its previous mode; nothing else to do.
	}
}

/**
 * Write a project's `.env`: `encrypted` keys as `enc:`, owner-only (0600),
 * and the `readable` secrets it keeps reported to the secure-storage status.
 */
export function writeProjectEnvFile(envPath: string, content: string): void {
	mkdirSync(path.dirname(envPath), { recursive: true });
	const encoded = encodeProjectEnvContent(content);
	writeFileSync(envPath, encoded, { encoding: "utf-8", mode: 0o600 });
	restrictToOwner(envPath);
	setReadableSecrets(envPath, readableSecretKeysOf(encoded));
}

/**
 * Bring a `.env` an earlier version wrote under this scheme: owner-only,
 * `encrypted` keys still in clear rewritten as `enc:`, `readable` secrets
 * reported. Without an OS keyring the values stay in clear and the banner
 * says so. Returns true when the file was rewritten.
 */
export function migrateProjectEnvFile(envPath: string): boolean {
	let content: string;
	try {
		content = readFileSync(envPath, "utf-8");
	} catch {
		return false;
	}
	restrictToOwner(envPath);
	setReadableSecrets(envPath, readableSecretKeysOf(content));
	if (!holdsPlaintextEncryptedKey(content)) return false;

	const encoded = encodeProjectEnvContent(content);
	if (encoded === content) return false;
	writeFileSync(envPath, encoded, { encoding: "utf-8", mode: 0o600 });
	restrictToOwner(envPath);
	return true;
}

/**
 * `migrateProjectEnvFile` for every project. Run once the app is ready
 * (safeStorage needs it on Linux and Windows); a project that fails is
 * skipped, never the others. Returns how many files were rewritten.
 */
export function migrateProjectEnvSecrets(
	projects: readonly ProjectLocation[],
): number {
	let rewritten = 0;
	for (const project of projects) {
		const envPath = getProjectEnvPath(project);
		if (!envPath) continue;
		try {
			if (migrateProjectEnvFile(envPath)) rewritten++;
		} catch (error) {
			console.warn(
				"[ProjectEnv] Could not migrate a project's .workpilot/.env:",
				error instanceof Error ? error.message : error,
			);
		}
	}
	return rewritten;
}
