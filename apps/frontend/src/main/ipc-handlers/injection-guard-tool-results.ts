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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolResultAlert } from "../../shared/types/injection-guard";

export const TRUSTED_SOURCES_FILE = path.join(".workpilot", "trusted-sources.json");
export const ALERTS_FILENAME = "injection_alerts.jsonl";
const KINDS = ["path", "host", "tool", "command"] as const;
const MAX_TRUSTED = 100;
const MAX_PATTERN = 200;
const MAX_ALERT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ALERTS = 200;


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

function isPlainFile(file: string): boolean {
	try {
		const st = lstatSync(file);
		return st.isFile() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

export function readTrustedSources(projectRoot: string): string[] {
	const file = path.join(projectRoot, TRUSTED_SOURCES_FILE);
	if (!isPlainFile(file)) return [];
	try {
		return validateTrustedSources(JSON.parse(readFileSync(file, "utf-8")));
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
	const file = path.join(projectRoot, TRUSTED_SOURCES_FILE);
	if (existsSync(file) && !isPlainFile(file)) {
		throw new Error("trusted-sources.json is not a plain file");
	}
	writeFileSync(file, `${JSON.stringify({ sources }, null, 2)}\n`, "utf-8");
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
			const file = path.join(root, spec, ALERTS_FILENAME);
			if (!isPlainFile(file)) continue;
			let text: string;
			try {
				if (lstatSync(file).size > MAX_ALERT_FILE_BYTES) continue;
				text = readFileSync(file, "utf-8");
			} catch {
				continue;
			}
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
