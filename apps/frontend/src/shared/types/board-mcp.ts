/**
 * The `workpilot-board` MCP server, as other apps see it.
 *
 * The server itself is the backend's (`apps/backend/board_mcp/`, stdio, one
 * project per process). These are the clients the app can register it with,
 * so a person does not type a Python path by hand
 * (`main/board-mcp/`, `docs/architecture/board-mcp.md`).
 */

export const BOARD_MCP_CLIENTS = [
	"claude-code",
	"codex",
	"gemini-cli",
	"copilot-cli",
	"vscode",
	"cursor",
	"claude-desktop",
	"windsurf",
	"opencode",
] as const;

export type BoardMcpClientId = (typeof BOARD_MCP_CLIENTS)[number];

export function isBoardMcpClient(value: unknown): value is BoardMcpClientId {
	return typeof value === "string" && (BOARD_MCP_CLIENTS as readonly string[]).includes(value);
}

/**
 * Whether a client already knows this project's server:
 * - `absent`: no entry under the server's name;
 * - `current`: the entry starts this app's runner for this project;
 * - `stale`: an entry of that name starts something else (an older install's
 *   path, another Python), and the button rewrites it.
 */
export type BoardMcpEntryState = "absent" | "current" | "stale";

export interface BoardMcpClientStatus {
	id: BoardMcpClientId;
	/** The client's configuration folder (or executable) was found. */
	detected: boolean;
	state: BoardMcpEntryState;
	/** Where the entry lives, `~` for the home folder; shown, never sent back. */
	location: string;
	/** The app can write the entry itself (else the person copies `snippet`). */
	writable: boolean;
	/** What to paste, in the client's own format, when the app cannot write it. */
	snippet: string;
	/** Why the config could not be read (invalid JSON, comments), if so. */
	readError?: string;
}

export interface BoardMcpStatus {
	/** The name the entry takes in every client: `workpilot-<project>`. */
	serverName: string;
	/** The command line every client runs, for display and copy. */
	command: string;
	args: string[];
	clients: BoardMcpClientStatus[];
}
