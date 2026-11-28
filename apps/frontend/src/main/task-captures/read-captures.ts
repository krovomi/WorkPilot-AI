/**
 * The captures a task prepared for its pull request, read from its spec
 * folder for the Captures tab and the Kanban card
 * (`docs/architecture/pr-captures.md`, « Dans l'app »).
 *
 * The backend writes `captures/publication.json` (`pr_captures/publication.py`),
 * `captures/pr-sync.json` (`core/capture_hosting/`) and, in review mode,
 * `captures/approval.json`. They are data from a build, so every field is
 * checked and bounded here before it reaches the renderer, and only the
 * fields the app shows are kept.
 *
 * The app shows the copies the pull request would show
 * (`captures/published/`), never an original: personal data in them is
 * already replaced by fakes. An image is read only when the publication
 * lists it, as a PNG resolved inside that folder.
 */

import fs from "node:fs";
import path from "node:path";
import type {
	TaskCaptureItem,
	TaskCaptureSide,
	TaskCaptureStatus,
	TaskCapturesPublishMode,
	TaskCapturesSummary,
	TaskCapturesSync,
	TaskCapturesSyncStatus,
} from "../../shared/types/task-captures";

export const CAPTURES_DIR = "captures";
export const PUBLICATION_FILE = "publication.json";
export const SYNC_FILE = "pr-sync.json";
export const APPROVAL_FILE = "approval.json";
export const PUBLISHED_DIR = "published";

/** Sizes read at most: a publication lists 12 screens, a sync is a few lines. */
const MAX_BYTES: Record<string, number> = {
	[PUBLICATION_FILE]: 400_000,
	[SYNC_FILE]: 20_000,
	[APPROVAL_FILE]: 40_000,
};
/** A published copy larger than this is not shown. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_ITEMS = 12;
const MAX_TEXT = 200;
const MAX_LIST = 20;

const STATUSES: readonly TaskCaptureStatus[] = [
	"pseudonymized",
	"clean",
	"unchecked",
	"withheld",
	"failed",
];
const PUBLISH_MODES: readonly TaskCapturesPublishMode[] = ["auto", "review", "never"];
const SYNC_STATUSES: readonly TaskCapturesSyncStatus[] = [
	"published",
	"waiting-review",
	"off",
	"nothing",
	"no-pr",
	"unsupported",
	"failed",
];
const CODE = /^[a-z0-9][a-z0-9:._-]{0,63}$/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One printable line, bounded; empty for anything else. */
export function cleanText(value: unknown, max = MAX_TEXT): string {
	if (typeof value !== "string") return "";
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) continue;
		out += ch;
		if (out.length >= max) break;
	}
	return out.trim();
}

function code(value: unknown): string {
	return typeof value === "string" && CODE.test(value) ? value : "";
}

function codes(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const found: string[] = [];
	for (const entry of value) {
		const c = code(entry);
		if (c && !found.includes(c)) found.push(c);
		if (found.length >= MAX_LIST) break;
	}
	return found;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? Math.min(value, 100_000)
		: 0;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function isoDate(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 40) return undefined;
	return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/**
 * A copy's path as the publication names it: relative, under
 * `captures/published/`, a PNG, no `..`. Empty for anything else.
 */
export function publishedFile(value: unknown): string {
	if (typeof value !== "string" || value.length > 300) return "";
	const posix = value.replaceAll("\\", "/");
	if (!posix.startsWith(`${CAPTURES_DIR}/${PUBLISHED_DIR}/`)) return "";
	if (!posix.toLowerCase().endsWith(".png")) return "";
	if (posix.split("/").some((part) => part === "" || part === "." || part === "..")) {
		return "";
	}
	return posix;
}

/* --------------------------------------------------------------- reading */

interface CachedJson {
	mtimeMs: number;
	size: number;
	value: unknown;
}

const jsonCache = new Map<string, CachedJson>();
const MAX_CACHE = 2_000;

function readJson(specDir: string, name: string): unknown {
	const file = path.join(specDir, CAPTURES_DIR, name);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		jsonCache.delete(file);
		return undefined;
	}
	if (!stat.isFile() || stat.size > (MAX_BYTES[name] ?? 0)) return undefined;
	const cached = jsonCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.value;
	}
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		value = undefined;
	}
	if (jsonCache.size >= MAX_CACHE) jsonCache.clear();
	jsonCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
	return value;
}

function mtimeOf(specDir: string, name: string): number {
	try {
		return fs.statSync(path.join(specDir, CAPTURES_DIR, name)).mtimeMs;
	} catch {
		return -1;
	}
}

/**
 * The copy of a task's spec folder whose publication is the newest, as
 * `core/capture_hosting.task_spec_dir` picks it: the project's, or the one in
 * the task's workspace. Undefined when neither has a publication.
 */
export function capturesSpecDir(candidates: readonly (string | null | undefined)[]): string | undefined {
	let best: string | undefined;
	let bestTime = -1;
	for (const dir of candidates) {
		if (!dir) continue;
		const time = mtimeOf(dir, PUBLICATION_FILE);
		if (time > bestTime) {
			best = dir;
			bestTime = time;
		}
	}
	return bestTime >= 0 ? best : undefined;
}

function toSide(raw: unknown): TaskCaptureSide | undefined {
	if (!isObject(raw)) return undefined;
	const privacy = isObject(raw.privacy) ? raw.privacy : {};
	const file = raw.publishable === true ? publishedFile(raw.file) : "";
	return {
		available: Boolean(file),
		status: choice(privacy.status, STATUSES, "failed"),
		kinds: codes(privacy.kinds),
		passes: codes(privacy.checks),
		replaced: count(privacy.replaced),
		file,
	};
}

function toItem(raw: unknown): TaskCaptureItem | undefined {
	if (!isObject(raw)) return undefined;
	const after = toSide(raw.after);
	if (!after) return undefined;
	const item: TaskCaptureItem = {
		key: cleanText(raw.key),
		label: cleanText(raw.label),
		platform: code(raw.platform) || "web",
		variant: code(raw.variant),
		route: cleanText(raw.route),
		locale: code(raw.locale),
		after,
		publishable: after.available,
	};
	const before = toSide(raw.before);
	if (before) item.before = before;
	return item;
}

function signaturesOf(raw: Json): string[] {
	const found: string[] = [];
	for (const item of Array.isArray(raw.items) ? raw.items : []) {
		if (!isObject(item)) continue;
		for (const side of [item.after, item.before]) {
			if (isObject(side) && side.publishable === true) {
				const signature = cleanText(side.signature, 80);
				if (signature) found.push(signature);
			}
		}
	}
	return found;
}

function approvedAll(specDir: string, signatures: string[]): boolean {
	if (signatures.length === 0) return false;
	const raw = readJson(specDir, APPROVAL_FILE);
	if (!isObject(raw) || !Array.isArray(raw.signatures)) return false;
	const approved = new Set(raw.signatures.filter((s): s is string => typeof s === "string"));
	return signatures.every((s) => approved.has(s));
}

export function readCapturesSync(specDir: string): TaskCapturesSync | undefined {
	const raw = readJson(specDir, SYNC_FILE);
	if (!isObject(raw)) return undefined;
	const prUrl = cleanText(raw.prUrl, 500);
	return {
		status: choice(raw.status, SYNC_STATUSES, "failed"),
		reason: code(raw.reason),
		prUrl: /^https:\/\//i.test(prUrl) ? prUrl : "",
		syncedAt: isoDate(raw.syncedAt),
		hosted: count(raw.hosted),
		section: raw.section === true,
	};
}

/** What the task prepared, or undefined when it has no publication. */
export function readCapturesSummary(specDir: string): TaskCapturesSummary | undefined {
	const raw = readJson(specDir, PUBLICATION_FILE);
	if (!isObject(raw) || raw.version !== 1) return undefined;
	const decision = isObject(raw.decision) ? raw.decision : {};
	const settings = isObject(raw.settings) ? raw.settings : {};
	const items = (Array.isArray(raw.items) ? raw.items : [])
		.slice(0, MAX_ITEMS)
		.map(toItem)
		.filter((item): item is TaskCaptureItem => Boolean(item));
	const publishable = items.filter((item) => item.publishable).length;
	const summary: TaskCapturesSummary = {
		needed: decision.needed === true,
		reason: code(decision.reason),
		decidedBy: code(decision.decidedBy) || "default",
		uiFiles: (Array.isArray(decision.uiFiles) ? decision.uiFiles : [])
			.map((file) => cleanText(file, 300))
			.filter(Boolean)
			.slice(0, MAX_LIST),
		publish: choice(settings.publish, PUBLISH_MODES, "auto"),
		generatedAt: isoDate(raw.generatedAt),
		items,
		publishable,
		withheld: items.length - publishable,
		approved: approvedAll(specDir, signaturesOf(raw)),
	};
	const sync = readCapturesSync(specDir);
	if (sync) summary.sync = sync;
	return summary;
}

/** The task has screens to show: the board's badge and the visual proof's step aside. */
export function hasCaptures(summary: TaskCapturesSummary | undefined): boolean {
	return Boolean(summary?.needed && summary.items.length > 0);
}

/* ---------------------------------------------------------------- images */

function listedFiles(summary: TaskCapturesSummary): Set<string> {
	const files = new Set<string>();
	for (const item of summary.items) {
		for (const side of [item.after, item.before]) {
			if (side?.file) files.add(side.file);
		}
	}
	return files;
}

/**
 * One published copy as base64, or an error code: `not-listed` (the
 * publication does not name it), `outside` (it resolves out of
 * `captures/published/`), `not-png`, `too-large`, `unreadable`.
 */
export function readPublishedImage(
	specDir: string,
	summary: TaskCapturesSummary,
	file: unknown,
): { base64: string } | { error: string } {
	const name = publishedFile(file);
	if (!name || !listedFiles(summary).has(name)) return { error: "not-listed" };
	let resolved: string;
	let root: string;
	try {
		root = fs.realpathSync(path.join(specDir, CAPTURES_DIR, PUBLISHED_DIR));
		resolved = fs.realpathSync(path.join(specDir, ...name.split("/")));
	} catch {
		return { error: "unreadable" };
	}
	const relative = path.relative(root, resolved);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		return { error: "outside" };
	}
	try {
		const stat = fs.statSync(resolved);
		if (!stat.isFile()) return { error: "unreadable" };
		if (stat.size > MAX_IMAGE_BYTES) return { error: "too-large" };
		const bytes = fs.readFileSync(resolved);
		if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
			return { error: "not-png" };
		}
		return { base64: bytes.toString("base64") };
	} catch {
		return { error: "unreadable" };
	}
}
