/**
 * Tool results the agents read, as the Injection Guard page shows them (#388).
 *
 * `security/tool_result_guard.py` scans every tool result before the agent
 * reads it and notes each flagged one in `<spec>/injection_alerts.jsonl`
 * (no content, only where it came from and what was seen). This reads those
 * notes for a project, and reads and writes the person's trusted sources,
 * `.workpilot/trusted-sources.json`: the only writer, since an agent may not
 * write that file (`security/path_guard.py`). The renderer is not trusted
 * (S6): every list is revalidated here with the backend's rules.
 */

import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import type { ToolResultAlert } from "../../shared/types/injection-guard";

export const TRUSTED_SOURCES_FILE = path.join(".workpilot", "trusted-sources.json");
export const ALERTS_FILENAME = "injection_alerts.jsonl";
const KINDS = ["path", "host", "tool", "command"] as const;
const MAX_TRUSTED = 100;
const MAX_PATTERN = 200;
const MAX_ALERT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ALERTS = 200;
const MAX_TRUSTED_FILE_BYTES = 256 * 1024;


/** The well-formed entries, in order: same rules as `validate_trusted_sources`. */
export function validateTrustedSources(raw: unknown): string[] {
	const entries =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as { sources?: unknown }).sources
			: raw;
	if (!Array.isArray(entries)) return [];
	const kept: string[] = [];
	for (const entry of entries.slice(0, MAX_TRUSTED)) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		const colon = trimmed.indexOf(":");
		if (colon < 0) continue;
		const kind = trimmed.slice(0, colon);
		const pattern = trimmed.slice(colon + 1).trim();
		if (!(KINDS as readonly string[]).includes(kind)) continue;
		if (!pattern || pattern.length > MAX_PATTERN) continue;
		if (pattern.replace(/[*?/. ]/g, "") === "") continue;
		const normalised = `${kind}:${pattern}`;
		if (!kept.includes(normalised)) kept.push(normalised);
	}
	return kept;
}

// A link could point anywhere on the disk: only plain files are read or
// written, checked on the descriptor itself so nothing can swap the file
// between the check and the use. O_NOFOLLOW refuses a link where it exists;
// Windows has none, so the name must still be the very file that was opened.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function openPlainFile(file: string, flags: number): number | null {
	let fd: number | null = null;
	try {
		fd = openSync(file, flags | NO_FOLLOW, 0o644);
		const stat = fstatSync(fd);
		const named = lstatSync(file);
		if (!stat.isFile() || !named.isFile() || named.ino !== stat.ino || named.dev !== stat.dev) {
			closeSync(fd);
			return null;
		}
		return fd;
	} catch {
		if (fd !== null) closeSync(fd);
		return null;
	}
}

/** The file's text, or null when it is missing, not a plain file or too big. */
function readPlainFile(file: string, maxBytes: number): string | null {
	const fd = openPlainFile(file, constants.O_RDONLY);
	if (fd === null) return null;
	try {
		const size = fstatSync(fd).size;
		if (size > maxBytes) return null;
		// Read what was measured, not what the file may have grown to since.
		const buffer = Buffer.alloc(size);
		const read = readSync(fd, buffer, 0, size, 0);
		return buffer.subarray(0, read).toString("utf-8");
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

export function readTrustedSources(projectRoot: string): string[] {
	const text = readPlainFile(path.join(projectRoot, TRUSTED_SOURCES_FILE), MAX_TRUSTED_FILE_BYTES);
	if (text === null) return [];
	try {
		return validateTrustedSources(JSON.parse(text));
	} catch {
		return [];
	}
}

/** Writes the valid entries and returns them; refuses a linked file or folder. */
export function writeTrustedSources(projectRoot: string, raw: unknown): string[] {
	const sources = validateTrustedSources(raw);
	const dir = path.join(projectRoot, ".workpilot");
	if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
		throw new Error(".workpilot is a link");
	}
	mkdirSync(dir, { recursive: true });
	const fd = openPlainFile(
		path.join(projectRoot, TRUSTED_SOURCES_FILE),
		constants.O_WRONLY | constants.O_CREAT,
	);
	if (fd === null) throw new Error("trusted-sources.json is not a plain file");
	try {
		ftruncateSync(fd, 0);
		writeSync(fd, `${JSON.stringify({ sources }, null, 2)}\n`, 0, "utf-8");
	} finally {
		closeSync(fd);
	}
	return sources;
}

function parseAlert(line: string, spec: string): ToolResultAlert | null {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Record<string, unknown>;
	const level = e.level === "blocked" ? "blocked" : e.level === "suspect" ? "suspect" : null;
	if (!level || typeof e.at !== "string" || typeof e.source !== "string") return null;
	return {
		spec,
		at: e.at,
		tool: typeof e.tool === "string" ? e.tool.slice(0, 120) : "",
		source: e.source.slice(0, 240),
		level,
		findings: Array.isArray(e.findings)
			? e.findings.filter((f): f is string => typeof f === "string").slice(0, 8)
			: [],
		action: e.action === "withheld" ? "withheld" : "fenced",
	};
}

function specRoots(projectRoot: string): string[] {
	const roots = [path.join(projectRoot, ".workpilot", "specs")];
	const trees = path.join(projectRoot, ".workpilot", "worktrees", "tasks");
	try {
		for (const tree of readdirSync(trees)) {
			roots.push(path.join(trees, tree, ".workpilot", "specs"));
		}
	} catch {
		// no task worktree yet
	}
	return roots;
}

/** Every task's flagged tool results, newest first, the same note kept once. */
export function readToolResultAlerts(projectRoot: string): ToolResultAlert[] {
	const seen = new Set<string>();
	const alerts: ToolResultAlert[] = [];
	for (const root of specRoots(projectRoot)) {
		let specs: string[];
		try {
			specs = readdirSync(root);
		} catch {
			continue;
		}
		for (const spec of specs) {
			const text = readPlainFile(path.join(root, spec, ALERTS_FILENAME), MAX_ALERT_FILE_BYTES);
			if (text === null) continue;
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				const alert = parseAlert(line, spec);
				if (!alert) continue;
				const key = `${spec}|${alert.at}|${alert.source}|${alert.tool}`;
				if (seen.has(key)) continue;
				seen.add(key);
				alerts.push(alert);
			}
		}
	}
	alerts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	return alerts.slice(0, MAX_ALERTS);
}
