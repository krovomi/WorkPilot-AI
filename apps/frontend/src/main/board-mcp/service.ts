/**
 * Registers a project's `workpilot-board` server with the apps a person uses.
 *
 * The command is built here, from what the app already runs: its Python and
 * its backend's `runners/board_mcp.py`, with `--project-dir` fixed to the
 * project. The renderer only names a project and a client; no path it sends
 * reaches a file or a command line.
 *
 * Python runs isolated (`-I`): a client's environment can hold a
 * `PYTHONHOME` or `PYTHONPATH` meant for something else, and the server needs
 * only the standard library and the backend folder the runner adds itself.
 * `-X utf8` replaces `PYTHONUTF8`, which `-I` would ignore.
 */

import {
	constants as fsConstants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	type BoardMcpClientId,
	type BoardMcpClientStatus,
	type BoardMcpStatus,
} from "../../shared/types/board-mcp";
import {
	type ClientDefinition,
	type ClientDirs,
	ConfigParseError,
	claudeAddArgs,
	claudeRemoveArgs,
	clientDefinitions,
	entryState,
	type ServerEntry,
	serverName,
	snippet,
	withEntry,
} from "./clients";

export const RUNNER = path.join("runners", "board_mcp.py");

export function buildEntry(
	python: [string, string[]],
	backendDir: string,
	projectDir: string,
): ServerEntry {
	const [command, baseArgs] = python;
	return {
		command,
		args: [
			...baseArgs,
			"-I",
			"-X",
			"utf8",
			path.join(backendDir, RUNNER),
			"--project-dir",
			projectDir,
		],
	};
}

/** Runs the `claude` CLI; resolves with its exit code and output. */
export type ClaudeRunner = (args: string[]) => Promise<{ code: number; output: string }>;

export interface BoardMcpContext {
	dirs: ClientDirs;
	entry: ServerEntry;
	projectName: string;
	/** Null when no usable `claude` executable was found. */
	claude: ClaudeRunner | null;
}

function display(file: string, home: string): string {
	return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

/** The file's text, or "" when there is none (read once, never checked first). */
function readText(file: string): string {
	try {
		return readFileSync(file, "utf-8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "";
		throw error;
	}
}

function clientStatus(def: ClientDefinition, context: BoardMcpContext): BoardMcpClientStatus {
	const name = serverName(context.projectName);
	const detected = existsSync(def.marker) || existsSync(def.file);
	const base = {
		id: def.id,
		detected,
		location: display(def.file, context.dirs.home),
		snippet: snippet(def.format, name, context.entry),
	};
	let state: BoardMcpClientStatus["state"] = "absent";
	let readError: string | undefined;
	try {
		state = entryState(def.format, readText(def.file), name, context.entry);
	} catch (error) {
		readError = error instanceof Error ? error.message : String(error);
	}
	const writable =
		detected && !readError && (def.format !== "claude-code" || context.claude !== null);
	return { ...base, state, writable, ...(readError ? { readError } : {}) };
}

export function boardMcpStatus(context: BoardMcpContext): BoardMcpStatus {
	return {
		serverName: serverName(context.projectName),
		command: context.entry.command,
		args: context.entry.args,
		clients: clientDefinitions(context.dirs).map((def) => clientStatus(def, context)),
	};
}

/**
 * Writes the file through a temporary sibling, so a client reading it never
 * sees half of it. The first time the app touches a file it keeps a copy
 * beside it (`<file>.workpilot.bak`).
 */
function writeAtomically(file: string, text: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	try {
		// One call, no check before it: EXCL leaves an earlier copy alone.
		copyFileSync(file, `${file}.workpilot.bak`, fsConstants.COPYFILE_EXCL);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "EEXIST") throw error;
	}
	const temporary = `${file}.workpilot.tmp`;
	writeFileSync(temporary, text, "utf-8");
	renameSync(temporary, file);
}

async function viaClaude(
	context: BoardMcpContext,
	name: string,
	add: boolean,
	present: boolean,
): Promise<void> {
	const claude = context.claude;
	if (!claude) throw new Error("claude_not_found");
	if (present) {
		const removed = await claude(claudeRemoveArgs(name));
		if (removed.code !== 0) throw new Error(removed.output.trim() || "claude mcp remove failed");
	}
	if (!add) return;
	const added = await claude(claudeAddArgs(name, context.entry));
	if (added.code !== 0) throw new Error(added.output.trim() || "claude mcp add-json failed");
}

/** Writes (or, with `add` false, removes) the entry in one client. */
export async function applyBoardMcp(
	context: BoardMcpContext,
	clientId: BoardMcpClientId,
	add: boolean,
): Promise<BoardMcpClientStatus> {
	const def = clientDefinitions(context.dirs).find((candidate) => candidate.id === clientId);
	if (!def) throw new Error("unknown client");
	const before = clientStatus(def, context);
	if (before.readError) throw new ConfigParseError(before.readError);
	if (!before.detected) throw new Error("client_not_found");
	const name = serverName(context.projectName);
	if (def.format === "claude-code") {
		await viaClaude(context, name, add, before.state !== "absent");
	} else if (add || before.state !== "absent") {
		const text = readText(def.file);
		writeAtomically(def.file, withEntry(def.format, text, name, add ? context.entry : null));
	}
	return clientStatus(def, context);
}
