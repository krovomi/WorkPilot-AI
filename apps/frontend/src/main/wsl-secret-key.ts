/**
 * Under WSL, the key secret-storage.ts encrypts secrets with when no Linux
 * keyring can: 32 random bytes, kept on disk only wrapped by Windows DPAPI
 * (`ProtectedData`, CurrentUser scope), unwrapped in memory at launch.
 * See docs/architecture/secrets-at-rest.md, "WSL: Windows DPAPI".
 *
 * WSL rarely has a usable Secret Service: none is installed, or GNOME Keyring
 * runs locked and its unlock prompt renders blank under WSLg (it once froze
 * the app, linux-password-store.ts). The Windows side of the same user always
 * has DPAPI, which is what safeStorage uses for the Windows build: the key is
 * bound to the Windows account, so a copy of the profile folder (backup,
 * another machine, another Windows user) cannot decrypt the secrets.
 *
 * DPAPI is reached through WSL interop: `powershell.exe` with a fixed script
 * (`-EncodedCommand`, no shell, no argument from the caller) reading the bytes
 * to wrap or unwrap on stdin. The child gets the variables interop needs, not
 * the app's environment (rule S4), and `WSLENV` empty, so nothing of it is
 * forwarded to Windows. Interop disabled, PowerShell restricted, a timeout:
 * the session has no key and secret-storage.ts falls back as before.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { detectWsl, readAutomountRoot } from "./open-external";
import { findExecutable } from "./platform";

export const WSL_KEY_FILE = "secret-key.dpapi";
const KEY_BYTES = 32;
/** PowerShell's cold start from WSL takes a second or two; a stall is not that. */
export const DPAPI_TIMEOUT_MS = 15000;
/** Ties the blob to WorkPilot AI: no other DPAPI blob of the user unwraps here. */
const ENTROPY = "WorkPilot-AI secrets at rest v1";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Reads mode then data (base64) from stdin, writes the result (base64). */
const DPAPI_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Security",
	"$mode = [Console]::In.ReadLine()",
	"$data = [Convert]::FromBase64String([Console]::In.ReadLine())",
	`$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
	"$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser",
	"if ($mode -eq 'protect') { $out = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) }",
	"elseif ($mode -eq 'unprotect') { $out = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }",
	"else { exit 2 }",
	"[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("\n");

/** What interop needs to start a Windows process; no secret (rule S4). */
const INTEROP_ENV_VARS = ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME"] as const;

export type DpapiMode = "protect" | "unprotect";

export interface WslKeyDeps {
	wsl: boolean;
	keyFile: string;
	/** Wrap or unwrap `data` with DPAPI; null when DPAPI cannot be reached. */
	dpapi: (mode: DpapiMode, data: Buffer) => Promise<Buffer | null>;
	readKeyFile: (file: string) => Promise<string | null>;
	/** Create the file, owner-only; false when it already exists. */
	createKeyFile: (file: string, content: string) => Promise<boolean>;
	random: (bytes: number) => Buffer;
}

export interface LoadOptions {
	/** Create the key when none is on disk yet. */
	create: boolean;
}

/**
 * The key, unwrapped: read from the key file, or created there when `create`
 * and none exists. Null outside WSL, without DPAPI, or when the file holds a
 * blob this Windows account cannot unwrap — then it is left as it is, since
 * the secrets it encrypted need it.
 */
export async function loadWslSecretKey(
	{ create }: LoadOptions,
	deps: WslKeyDeps = defaultDeps(),
): Promise<Buffer | null> {
	if (!deps.wsl) return null;
	const stored = await deps.readKeyFile(deps.keyFile);
	if (stored !== null) return unwrap(stored, deps);
	if (!create) return null;
	const key = deps.random(KEY_BYTES);
	const wrapped = await deps.dpapi("protect", key);
	if (!wrapped) return null;
	// Unwrap what is about to be written: a key DPAPI cannot give back must
	// never encrypt a secret.
	const check = await deps.dpapi("unprotect", wrapped);
	if (!check?.equals(key)) return null;
	if (await deps.createKeyFile(deps.keyFile, wrapped.toString("base64"))) {
		return key;
	}
	// Another instance created it first: use that one.
	const winner = await deps.readKeyFile(deps.keyFile);
	return winner === null ? null : unwrap(winner, deps);
}

async function unwrap(stored: string, deps: WslKeyDeps): Promise<Buffer | null> {
	const text = stored.trim();
	if (!BASE64.test(text)) return null;
	const key = await deps.dpapi("unprotect", Buffer.from(text, "base64"));
	return key?.length === KEY_BYTES ? key : null;
}

/** Where Windows PowerShell lives, as this WSL distribution sees the C: drive. */
export function powershellPath(
	automountRoot: string,
	exists: (file: string) => boolean = existsSync,
	find: (name: string) => string | null = findExecutable,
): string | null {
	const root = automountRoot.endsWith("/") ? automountRoot : `${automountRoot}/`;
	const builtIn = `${root}c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`;
	if (exists(builtIn)) return builtIn;
	return find("powershell.exe");
}

/** The UTF-16LE base64 `-EncodedCommand` expects. */
export function encodedDpapiScript(): string {
	return Buffer.from(DPAPI_SCRIPT, "utf16le").toString("base64");
}

/** One DPAPI call through `powershell.exe`: its result, or null on any failure. */
export function runDpapi(
	powershell: string,
	mode: DpapiMode,
	data: Buffer,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Buffer | null> {
	const childEnv: Record<string, string> = { WSLENV: "" };
	for (const name of INTEROP_ENV_VARS) {
		const value = env[name];
		if (value) childEnv[name] = value;
	}
	return new Promise((resolve) => {
		try {
			const child = execFile(
				powershell,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					encodedDpapiScript(),
				],
				{
					env: childEnv,
					timeout: DPAPI_TIMEOUT_MS,
					maxBuffer: 64 * 1024,
					windowsHide: true,
					encoding: "utf8",
				},
				(error, stdout) => {
					const text = String(stdout ?? "").trim();
					if (error || !BASE64.test(text)) {
						resolve(null);
						return;
					}
					resolve(Buffer.from(text, "base64"));
				},
			);
			child.stdin?.on("error", () => resolve(null));
			child.stdin?.end(`${mode}\n${data.toString("base64")}\n`);
		} catch {
			resolve(null);
		}
	});
}

function defaultDeps(): WslKeyDeps {
	const powershell = detectWsl() ? powershellPath(readAutomountRoot()) : null;
	return {
		wsl: powershell !== null,
		// Outside WSL nothing is read: no userData path to ask Electron for.
		keyFile: powershell ? join(app.getPath("userData"), WSL_KEY_FILE) : "",
		dpapi: (mode, data) =>
			powershell ? runDpapi(powershell, mode, data) : Promise.resolve(null),
		readKeyFile: async (file) => {
			try {
				return await readFile(file, "utf8");
			} catch {
				return null;
			}
		},
		createKeyFile: async (file, content) => {
			try {
				await writeFile(file, content, { mode: 0o600, flag: "wx" });
				return true;
			} catch {
				return false;
			}
		},
		random: randomBytes,
	};
}
