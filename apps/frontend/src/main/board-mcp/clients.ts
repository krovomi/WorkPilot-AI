/**
 * The apps that can start `workpilot-board`, and how each one stores it.
 *
 * Pure functions over a config file's text: read the entry under a name,
 * write it, remove it, and the snippet a person pastes when the app does not
 * write the file. Every other key of the file is kept as it was. A file that
 * does not parse is never rewritten: the person gets the snippet instead.
 *
 * Formats, as each client documents them (November 2026):
 * - `mcpServers`: Claude Desktop, Cursor, Gemini CLI, Windsurf, Copilot CLI
 *   (`type: "local"`, `tools: ["*"]`);
 * - VS Code (Copilot Chat): `servers`, `type: "stdio"`;
 * - OpenCode: `mcp`, `type: "local"`, `command` as one array;
 * - Codex: a `[mcp_servers.<name>]` table of `~/.codex/config.toml`;
 * - hermes-agent: `mcp_servers.<name>` in `<HERMES_HOME>/config.yaml`,
 *   edited as a YAML document so the comments a person wrote there stay;
 * - Claude Code: `~/.claude.json`, which Claude Code itself rewrites while it
 *   runs, so the app only reads it and writes through `claude mcp add-json`.
 */

import path from "node:path";
import { isMap, parseDocument } from "yaml";
import type { BoardMcpClientId } from "../../shared/types/board-mcp";

export interface ServerEntry {
	command: string;
	args: string[];
}

export type ClientFormat =
	| "mcp-servers"
	| "copilot"
	| "vscode"
	| "opencode"
	| "codex-toml"
	| "hermes-yaml"
	| "claude-code";

export interface ClientDefinition {
	id: BoardMcpClientId;
	format: ClientFormat;
	/** The config file the entry lives in. */
	file: string;
	/** A folder whose presence says the client is installed. */
	marker: string;
}

export interface ClientDirs {
	home: string;
	/** Electron's `appData`: %APPDATA%, ~/Library/Application Support, ~/.config. */
	appData: string;
	codexHome?: string;
	xdgConfig?: string;
	/** `HERMES_HOME`, or `%LOCALAPPDATA%\\hermes` on Windows; `~/.hermes` otherwise. */
	hermesHome?: string;
}

export function clientDefinitions(dirs: ClientDirs): ClientDefinition[] {
	const { home, appData } = dirs;
	const codex = dirs.codexHome || path.join(home, ".codex");
	const xdg = dirs.xdgConfig || path.join(home, ".config");
	const hermes = dirs.hermesHome || path.join(home, ".hermes");
	const def = (
		id: BoardMcpClientId,
		format: ClientFormat,
		file: string,
		marker = path.dirname(file),
	): ClientDefinition => ({ id, format, file, marker });
	return [
		def("claude-code", "claude-code", path.join(home, ".claude.json"), path.join(home, ".claude")),
		def("codex", "codex-toml", path.join(codex, "config.toml")),
		def("gemini-cli", "mcp-servers", path.join(home, ".gemini", "settings.json")),
		def("copilot-cli", "copilot", path.join(home, ".copilot", "mcp-config.json")),
		def("vscode", "vscode", path.join(appData, "Code", "User", "mcp.json")),
		def("cursor", "mcp-servers", path.join(home, ".cursor", "mcp.json")),
		def(
			"claude-desktop",
			"mcp-servers",
			path.join(appData, "Claude", "claude_desktop_config.json"),
		),
		def("windsurf", "mcp-servers", path.join(home, ".codeium", "windsurf", "mcp_config.json")),
		def("opencode", "opencode", path.join(xdg, "opencode", "opencode.json")),
		def("hermes", "hermes-yaml", path.join(hermes, "config.yaml")),
	];
}

/** `workpilot-<project>`: letters, digits and dashes, as every client accepts. */
export function serverName(projectName: string): string {
	const slug = projectName
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug ? `workpilot-${slug}` : "workpilot-board";
}

// ── JSON clients ─────────────────────────────────────────────────────────

const JSON_KEY: Record<Exclude<ClientFormat, "codex-toml" | "hermes-yaml">, string> = {
	"mcp-servers": "mcpServers",
	copilot: "mcpServers",
	vscode: "servers",
	opencode: "mcp",
	"claude-code": "mcpServers",
};

/** The entry as the client stores it. */
export function renderEntry(format: ClientFormat, entry: ServerEntry): Record<string, unknown> {
	switch (format) {
		case "copilot":
			return { type: "local", command: entry.command, args: entry.args, tools: ["*"] };
		case "vscode":
			return { type: "stdio", command: entry.command, args: entry.args };
		case "opencode":
			return { type: "local", command: [entry.command, ...entry.args], enabled: true };
		case "claude-code":
			return { type: "stdio", command: entry.command, args: entry.args };
		default:
			return { command: entry.command, args: entry.args };
	}
}

/** The command line a stored entry runs, whatever the client's format. */
function storedCommand(format: ClientFormat, value: unknown): string[] | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (format === "opencode") {
		return Array.isArray(record.command) ? record.command.map(String) : null;
	}
	if (typeof record.command !== "string") return null;
	const args = Array.isArray(record.args) ? record.args.map(String) : [];
	return [record.command, ...args];
}

function sameCommand(a: string[] | null, entry: ServerEntry): boolean {
	const b = [entry.command, ...entry.args];
	return !!a && a.length === b.length && a.every((part, i) => part === b[i]);
}

export class ConfigParseError extends Error {}

function parseJsonObject(text: string): Record<string, unknown> {
	if (!text.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ConfigParseError(error instanceof Error ? error.message : "invalid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigParseError("not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function jsonSection(config: Record<string, unknown>, key: string): Record<string, unknown> {
	const section = config[key];
	if (section === undefined) return {};
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		throw new ConfigParseError(`"${key}" is not an object`);
	}
	return section as Record<string, unknown>;
}

// ── Codex (TOML) ─────────────────────────────────────────────────────────

/** A TOML basic string: JSON's escapes are TOML's for what a path holds. */
function tomlString(value: string): string {
	return JSON.stringify(value);
}

function tomlBlock(name: string, entry: ServerEntry): string {
	return [
		`[mcp_servers.${name}]`,
		`command = ${tomlString(entry.command)}`,
		`args = [${entry.args.map(tomlString).join(", ")}]`,
		"",
	].join("\n");
}

/** Line range [start, end) of the `[mcp_servers.<name>]` table, if present. */
function tomlRange(lines: string[], name: string): [number, number] | null {
	const headers = new Set([
		`[mcp_servers.${name}]`,
		`[mcp_servers."${name}"]`,
		`[mcp_servers.'${name}']`,
	]);
	const start = lines.findIndex((line) => headers.has(line.trim()));
	if (start < 0) return null;
	let end = start + 1;
	while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
	return [start, end];
}

function tomlValue(raw: string): string | null {
	try {
		const value: unknown = JSON.parse(raw.trim());
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function readToml(text: string, name: string): string[] | null | undefined {
	const lines = text.split(/\r?\n/);
	const range = tomlRange(lines, name);
	if (!range) return undefined;
	let command: string | null = null;
	let args: string[] = [];
	for (const line of lines.slice(range[0] + 1, range[1])) {
		const match = /^\s*(command|args)\s*=\s*(.+)$/.exec(line);
		if (!match) continue;
		if (match[1] === "command") command = tomlValue(match[2]);
		else {
			try {
				const parsed: unknown = JSON.parse(match[2].trim());
				args = Array.isArray(parsed) ? parsed.map(String) : [];
			} catch {
				args = [];
			}
		}
	}
	return command === null ? null : [command, ...args];
}

function writeToml(text: string, name: string, entry: ServerEntry | null): string {
	const lines = text.split(/\r?\n/);
	const range = tomlRange(lines, name);
	const block = entry ? tomlBlock(name, entry).split("\n") : [];
	if (range) {
		lines.splice(range[0], range[1] - range[0], ...block);
		return lines.join("\n").replace(/\n{3,}/g, "\n\n");
	}
	if (!entry) return text;
	const body = text.replace(/\s*$/, "");
	return `${body ? `${body}\n\n` : ""}${block.join("\n")}`;
}

// ── hermes-agent (YAML) ──────────────────────────────────────────────────

const HERMES_KEY = "mcp_servers";

/** The document, refusing one a rewrite could damage. */
function parseYamlConfig(text: string) {
	const doc = parseDocument(text);
	if (doc.errors.length > 0) throw new ConfigParseError(doc.errors[0].message);
	if (doc.contents !== null && !isMap(doc.contents)) {
		throw new ConfigParseError("not a YAML mapping");
	}
	const section = doc.get(HERMES_KEY);
	if (section !== undefined && section !== null && !isMap(section)) {
		throw new ConfigParseError(`"${HERMES_KEY}" is not a mapping`);
	}
	return doc;
}

function readYaml(text: string, name: string): string[] | null | undefined {
	const doc = parseYamlConfig(text);
	if (!doc.hasIn([HERMES_KEY, name])) return undefined;
	const value: unknown = doc.toJS()?.[HERMES_KEY]?.[name];
	return storedCommand("hermes-yaml", value);
}

function writeYaml(text: string, name: string, entry: ServerEntry | null): string {
	const doc = parseYamlConfig(text);
	if (entry) doc.setIn([HERMES_KEY, name], { command: entry.command, args: entry.args });
	else if (doc.hasIn([HERMES_KEY, name])) doc.deleteIn([HERMES_KEY, name]);
	else return text;
	return doc.toString();
}

function yamlBlock(name: string, entry: ServerEntry): string {
	return [
		`${HERMES_KEY}:`,
		`  ${name}:`,
		`    command: ${JSON.stringify(entry.command)}`,
		"    args:",
		...entry.args.map((arg) => `      - ${JSON.stringify(arg)}`),
		"",
	].join("\n");
}

// ── One API over every format ────────────────────────────────────────────

/** The stored entry's state; throws `ConfigParseError` on an unreadable file. */
export function entryState(
	format: ClientFormat,
	text: string,
	name: string,
	entry: ServerEntry,
): "absent" | "current" | "stale" {
	if (format === "codex-toml") {
		const stored = readToml(text, name);
		if (stored === undefined) return "absent";
		return sameCommand(stored, entry) ? "current" : "stale";
	}
	if (format === "hermes-yaml") {
		const stored = readYaml(text, name);
		if (stored === undefined) return "absent";
		return sameCommand(stored, entry) ? "current" : "stale";
	}
	const section = jsonSection(parseJsonObject(text), JSON_KEY[format]);
	if (!(name in section)) return "absent";
	return sameCommand(storedCommand(format, section[name]), entry) ? "current" : "stale";
}

/** The file's new text with the entry written (or removed when `entry` is null). */
export function withEntry(
	format: Exclude<ClientFormat, "claude-code">,
	text: string,
	name: string,
	entry: ServerEntry | null,
): string {
	if (format === "codex-toml") return writeToml(text, name, entry);
	if (format === "hermes-yaml") return writeYaml(text, name, entry);
	const config = parseJsonObject(text);
	const key = JSON_KEY[format];
	const section = { ...jsonSection(config, key) };
	if (entry) section[name] = renderEntry(format, entry);
	else delete section[name];
	const next: Record<string, unknown> = { ...config, [key]: section };
	if (format === "opencode" && !("$schema" in config)) {
		next.$schema = "https://opencode.ai/config.json";
	}
	return `${JSON.stringify(next, null, 2)}\n`;
}

/** A shell word, quoted only when it needs to be. */
function shellWord(word: string): string {
	return /^[\w@%+=:,./\\-]+$/.test(word) ? word : `"${word.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** What a person pastes into the client when the app does not write it. */
export function snippet(format: ClientFormat, name: string, entry: ServerEntry): string {
	if (format === "claude-code") {
		return ["claude", "mcp", "add", "--scope", "user", name, "--", entry.command, ...entry.args]
			.map(shellWord)
			.join(" ");
	}
	if (format === "codex-toml") return tomlBlock(name, entry);
	if (format === "hermes-yaml") return yamlBlock(name, entry);
	return JSON.stringify(
		{ [JSON_KEY[format]]: { [name]: renderEntry(format, entry) } },
		null,
		2,
	);
}

/** The arguments of `claude mcp add-json` for the entry. */
export function claudeAddArgs(name: string, entry: ServerEntry): string[] {
	return [
		"mcp",
		"add-json",
		"--scope",
		"user",
		name,
		JSON.stringify(renderEntry("claude-code", entry)),
	];
}

export function claudeRemoveArgs(name: string): string[] {
	return ["mcp", "remove", "--scope", "user", name];
}
