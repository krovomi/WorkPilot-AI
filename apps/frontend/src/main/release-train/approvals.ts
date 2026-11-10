/**
 * The release train's approvals (#362) and what the renderer may send.
 *
 * A train file runs commands, so it runs only once the person approved this
 * exact file: main hashes it itself (SHA-256, never through a link, 64 KB at
 * most) and keeps the approved hash per project in the app's own data folder,
 * outside the project. A commit that changes the file changes its hash, and the
 * page asks again. The runner checks the hash once more before it runs
 * anything.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TRAIN_FILES = ["release-train.yaml", path.join(".workpilot", "release-train.yaml")];
const MAX_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,30}$/;
const SERVICE = /^[\w@./-]{1,80}$/;
const FLAG = /^[\w.:-]{1,100}$/;
const RUN_ID = /^rt-\d{8}-\d{6}-[0-9a-f]{6}$/;
const ACTIONS = new Set(["continue", "confirm", "retry", "rollback", "abort"]);

/** The file's bytes when no part of its path is a link and it is a small regular file. */
function readTrainBytes(root: string, relative: string): Buffer | null {
	let current = root;
	for (const part of relative.split(path.sep)) {
		current = path.join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) return null;
		} catch {
			return null;
		}
	}
	let fd: number | null = null;
	try {
		fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const stat = fstatSync(fd);
		const named = lstatSync(current);
		if (!stat.isFile() || named.ino !== stat.ino || named.dev !== stat.dev || stat.size > MAX_BYTES) return null;
		const buffer = Buffer.alloc(stat.size);
		const read = readSync(fd, buffer, 0, stat.size, 0);
		return buffer.subarray(0, read);
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** The SHA-256 of the project's train file, or null when it has none it can read. */
export function trainFileHash(root: string): string | null {
	for (const relative of TRAIN_FILES) {
		const bytes = readTrainBytes(root, relative);
		if (bytes) return createHash("sha256").update(bytes).digest("hex");
	}
	return null;
}

function readStore(file: string): Record<string, string> {
	try {
		const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) return {};
		return Object.fromEntries(
			Object.entries(data as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string" && SHA256.test(entry[1]),
			),
		);
	} catch {
		return {};
	}
}

export function approvedHash(file: string, root: string): string | null {
	return readStore(file)[root] ?? null;
}

/** Keeps `sha256` as approved for `root` when it is still the file's hash; false otherwise. */
export function approve(file: string, root: string, sha256: unknown): boolean {
	if (typeof sha256 !== "string" || !SHA256.test(sha256) || trainFileHash(root) !== sha256) return false;
	const store = readStore(file);
	store[root] = sha256;
	writeFileSync(file, JSON.stringify(store, null, 1), { encoding: "utf-8", mode: 0o600 });
	return true;
}

export function readEnvironment(value: unknown): string | null {
	return typeof value === "string" && ENVIRONMENT.test(value) ? value : null;
}

export function readServices(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 100) return null;
	return value.every((s) => typeof s === "string" && SERVICE.test(s)) ? (value as string[]) : null;
}

export function readRunId(value: unknown): string | null {
	return typeof value === "string" && RUN_ID.test(value) ? value : null;
}

export function readAction(value: unknown): string | null {
	return typeof value === "string" && ACTIONS.has(value) ? value : null;
}

/** A service name, or `flag:<key>`, or nothing. */
export function readTarget(value: unknown): string | null {
	if (value === undefined || value === "") return "";
	if (typeof value !== "string") return null;
	if (value.startsWith("flag:")) return FLAG.test(value.slice(5)) ? value : null;
	return SERVICE.test(value) ? value : null;
}

/** Only the variables the train file names, from the project's environment (S1). */
export function pickVariables(env: Record<string, string>, names: unknown): Record<string, string> {
	if (!Array.isArray(names)) return {};
	const picked: Record<string, string> = {};
	for (const name of names) {
		if (typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && env[name] !== undefined) {
			picked[name] = env[name];
		}
	}
	return picked;
}
