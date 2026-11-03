/**
 * The paste-in entry of the team server's `/mcp` for each AI app: the shape
 * each app reads, and the token only where the app sends it as a header.
 */
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BOARD_MCP_CLIENTS } from "../../types/board-mcp";
import { httpSnippet, SERVER_MCP_NAME } from "../board-mcp-http";

const URL = "https://team.example.com/mcp";
const TOKEN = "wpat_abcDEF123-_xyz";
const AUTH = `Bearer ${TOKEN}`;

function parsed(client: (typeof BOARD_MCP_CLIENTS)[number]) {
	return JSON.parse(httpSnippet(client, URL, TOKEN));
}

describe("httpSnippet", () => {
	it("gives every client an entry naming the url and the token", () => {
		for (const client of BOARD_MCP_CLIENTS) {
			const text = httpSnippet(client, URL, TOKEN);
			expect(text).toContain(URL);
			expect(text).toContain(TOKEN);
			expect(text).toContain(SERVER_MCP_NAME);
		}
	});

	it("puts the token in the Authorization header for Gemini CLI", () => {
		expect(parsed("gemini-cli").mcpServers[SERVER_MCP_NAME]).toEqual({
			httpUrl: URL,
			headers: { Authorization: AUTH },
		});
	});

	it("declares an http server with every tool for Copilot CLI", () => {
		expect(parsed("copilot-cli").mcpServers[SERVER_MCP_NAME]).toEqual({
			type: "http",
			url: URL,
			headers: { Authorization: AUTH },
			tools: ["*"],
		});
	});

	it("uses VS Code's servers key", () => {
		expect(parsed("vscode")).toEqual({
			servers: { [SERVER_MCP_NAME]: { type: "http", url: URL, headers: { Authorization: AUTH } } },
		});
	});

	it("uses serverUrl for Windsurf and url for Cursor", () => {
		expect(parsed("windsurf").mcpServers[SERVER_MCP_NAME].serverUrl).toBe(URL);
		expect(parsed("cursor").mcpServers[SERVER_MCP_NAME]).toEqual({
			url: URL,
			headers: { Authorization: AUTH },
		});
	});

	it("declares a remote server for OpenCode", () => {
		const entry = parsed("opencode").mcp[SERVER_MCP_NAME];
		expect(entry).toEqual({
			type: "remote",
			url: URL,
			headers: { Authorization: AUTH },
			enabled: true,
		});
	});

	it("writes Hermes's YAML: a url entry is Streamable HTTP, its headers sent as is", () => {
		expect(parseYaml(httpSnippet("hermes", URL, TOKEN))).toEqual({
			mcp_servers: {
				[SERVER_MCP_NAME]: { url: URL, headers: { Authorization: AUTH } },
			},
		});
	});

	it("writes a Codex TOML table with http_headers", () => {
		expect(httpSnippet("codex", URL, TOKEN)).toBe(
			[
				`[mcp_servers.${SERVER_MCP_NAME}]`,
				`url = "${URL}"`,
				`http_headers = { Authorization = "${AUTH}" }`,
				"",
			].join("\n"),
		);
	});

	it("bridges Claude Desktop through mcp-remote, the token in env only", () => {
		const entry = parsed("claude-desktop").mcpServers[SERVER_MCP_NAME];
		expect(entry.command).toBe("npx");
		expect(entry.args).toEqual([
			"-y",
			"mcp-remote",
			URL,
			"--header",
			`Authorization:$${"{"}WORKPILOT_AUTH}`,
		]);
		expect(entry.env).toEqual({ WORKPILOT_AUTH: AUTH });
		expect(entry.args.join(" ")).not.toContain(TOKEN);
	});

	it("quotes the header of the Claude Code command as one shell word", () => {
		expect(httpSnippet("claude-code", URL, TOKEN)).toBe(
			`claude mcp add --transport http --scope user ${SERVER_MCP_NAME} ${URL} --header "Authorization: ${AUTH}"`,
		);
	});

	it("escapes shell characters a url could carry", () => {
		const text = httpSnippet("claude-code", "https://h/mcp?a=$x`y`", TOKEN);
		expect(text).toContain('"https://h/mcp?a=\\$x\\`y\\`"');
	});
});
