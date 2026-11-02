/**
 * What to paste in each AI app to reach the team server's `/mcp` with a
 * personal access token (`apps/backend/shared_board/mcp_http.py`).
 *
 * Streamable HTTP, as each app documents it (November 2026). Claude Desktop
 * takes remote servers only as connectors (OAuth), so its entry goes through
 * the `mcp-remote` bridge, the token in an environment variable of the entry.
 */

import type { BoardMcpClientId } from "../types/board-mcp";

export const SERVER_MCP_NAME = "workpilot-server";

/** Claude Desktop's entry keeps the header in this variable of its `env`. */
const AUTH_ENV = "WORKPILOT_AUTH";

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function shellWord(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function httpSnippet(client: BoardMcpClientId, url: string, token: string): string {
	const name = SERVER_MCP_NAME;
	const auth = `Bearer ${token}`;
	const headers = { Authorization: auth };
	switch (client) {
		case "claude-code":
			return [
				"claude",
				"mcp",
				"add",
				"--transport",
				"http",
				"--scope",
				"user",
				name,
				url,
				"--header",
				`Authorization: ${auth}`,
			]
				.map(shellWord)
				.join(" ");
		case "codex":
			return [
				`[mcp_servers.${name}]`,
				`url = ${JSON.stringify(url)}`,
				`http_headers = { Authorization = ${JSON.stringify(auth)} }`,
				"",
			].join("\n");
		case "gemini-cli":
			return json({ mcpServers: { [name]: { httpUrl: url, headers } } });
		case "copilot-cli":
			return json({
				mcpServers: { [name]: { type: "http", url, headers, tools: ["*"] } },
			});
		case "vscode":
			return json({ servers: { [name]: { type: "http", url, headers } } });
		case "windsurf":
			return json({ mcpServers: { [name]: { serverUrl: url, headers } } });
		case "opencode":
			return json({
				$schema: "https://opencode.ai/config.json",
				mcp: { [name]: { type: "remote", url, headers, enabled: true } },
			});
		case "claude-desktop":
			return json({
				mcpServers: {
					[name]: {
						command: "npx",
						args: ["-y", "mcp-remote", url, "--header", `Authorization:\${${AUTH_ENV}}`],
						env: { [AUTH_ENV]: auth },
					},
				},
			});
		default:
			return json({ mcpServers: { [name]: { url, headers } } });
	}
}
