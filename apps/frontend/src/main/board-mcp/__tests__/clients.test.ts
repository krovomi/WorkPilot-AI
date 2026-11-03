/**
 * Every client's format: the entry written, read back as current, seen as
 * stale when it runs something else, removed, and the rest of the file kept.
 */
import { describe, expect, it } from "vitest";
import {
	type ClientFormat,
	ConfigParseError,
	claudeAddArgs,
	clientDefinitions,
	entryState,
	type ServerEntry,
	serverName,
	snippet,
	withEntry,
} from "../clients";

const entry: ServerEntry = {
	command: "/opt/py/bin/python3",
	args: ["-I", "-X", "utf8", "/app/backend/runners/board_mcp.py", "--project-dir", "/work/My App"],
};
const older: ServerEntry = { ...entry, command: "/old/python" };

const writable: Exclude<ClientFormat, "claude-code">[] = [
	"mcp-servers",
	"copilot",
	"vscode",
	"opencode",
	"codex-toml",
	"hermes-yaml",
];

describe("serverName", () => {
	it("is workpilot- and a slug every client accepts", () => {
		expect(serverName("Mon Projet Été!")).toBe("workpilot-mon-projet-ete");
		expect(serverName("***")).toBe("workpilot-board");
		expect(serverName("a".repeat(80))).toBe(`workpilot-${"a".repeat(40)}`);
	});
});

describe.each(writable)("format %s", (format) => {
	const existing =
		format === "codex-toml"
			? 'model = "o5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = []\n'
			: format === "hermes-yaml"
				? "# my hermes config\nmodel: o5\nmcp_servers:\n  other:\n    command: x\n"
				: JSON.stringify({ theme: "dark", [format === "vscode" ? "servers" : format === "opencode" ? "mcp" : "mcpServers"]: { other: { command: "x" } } });

	it("writes the entry and keeps the rest", () => {
		const text = withEntry(format, existing, "workpilot-app", entry);
		expect(entryState(format, text, "workpilot-app", entry)).toBe("current");
		expect(entryState(format, text, "other", entry)).toBe("stale");
		if (format === "codex-toml") expect(text).toContain('model = "o5"');
		else if (format === "hermes-yaml") {
			expect(text).toContain("# my hermes config");
			expect(text).toContain("model: o5");
		} else expect(JSON.parse(text).theme).toBe("dark");
	});

	it("sees an entry that runs something else as stale, and rewrites it", () => {
		const text = withEntry(format, existing, "workpilot-app", older);
		expect(entryState(format, text, "workpilot-app", entry)).toBe("stale");
		const rewritten = withEntry(format, text, "workpilot-app", entry);
		expect(entryState(format, rewritten, "workpilot-app", entry)).toBe("current");
		if (format === "codex-toml") {
			expect(rewritten.match(/\[mcp_servers\.workpilot-app\]/g)).toHaveLength(1);
		}
	});

	it("removes the entry only", () => {
		const text = withEntry(format, existing, "workpilot-app", entry);
		const removed = withEntry(format, text, "workpilot-app", null);
		expect(entryState(format, removed, "workpilot-app", entry)).toBe("absent");
		expect(entryState(format, removed, "other", entry)).toBe("stale");
	});

	it("starts an empty file", () => {
		expect(entryState(format, "", "workpilot-app", entry)).toBe("absent");
		const text = withEntry(format, "", "workpilot-app", entry);
		expect(entryState(format, text, "workpilot-app", entry)).toBe("current");
	});

	it("has a snippet that reads back as the entry", () => {
		const text = snippet(format, "workpilot-app", entry);
		expect(entryState(format, text, "workpilot-app", entry)).toBe("current");
	});
});

describe("formats as each client documents them", () => {
	it("Copilot CLI, VS Code and OpenCode use their own keys", () => {
		const copilot = JSON.parse(withEntry("copilot", "", "w", entry));
		expect(copilot.mcpServers.w).toMatchObject({ type: "local", tools: ["*"] });
		const vscode = JSON.parse(withEntry("vscode", "", "w", entry));
		expect(vscode.servers.w).toMatchObject({ type: "stdio", command: entry.command });
		const opencode = JSON.parse(withEntry("opencode", "", "w", entry));
		expect(opencode.mcp.w.command).toEqual([entry.command, ...entry.args]);
		expect(opencode.$schema).toBe("https://opencode.ai/config.json");
	});

	it("Codex gets a TOML table with escaped Windows paths", () => {
		const windows: ServerEntry = { command: "C:\\Py\\python.exe", args: ["C:\\a b\\board_mcp.py"] };
		const text = withEntry("codex-toml", "", "w", windows);
		expect(text).toContain('[mcp_servers.w]\ncommand = "C:\\\\Py\\\\python.exe"');
		expect(entryState("codex-toml", text, "w", windows)).toBe("current");
	});

	it("hermes gets mcp_servers in its YAML config, comments kept", () => {
		const windows: ServerEntry = { command: "C:\\Py\\python.exe", args: ["C:\\a b\\board_mcp.py"] };
		const before = "# hermes\nmodel:\n  default: x # inline\n";
		const text = withEntry("hermes-yaml", before, "w", windows);
		expect(text).toContain("# hermes");
		expect(text).toContain("# inline");
		expect(entryState("hermes-yaml", text, "w", windows)).toBe("current");
		expect(withEntry("hermes-yaml", before, "w", null)).toBe(before);
		expect(entryState("hermes-yaml", snippet("hermes-yaml", "w", windows), "w", windows)).toBe(
			"current",
		);
	});

	it("Claude Code is read from ~/.claude.json and written through its CLI", () => {
		const text = JSON.stringify({ mcpServers: { w: { type: "stdio", ...entry } }, projects: {} });
		expect(entryState("claude-code", text, "w", entry)).toBe("current");
		const args = claudeAddArgs("w", entry);
		expect(args.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "user", "w"]);
		expect(JSON.parse(args[5])).toEqual({ type: "stdio", ...entry });
		expect(snippet("claude-code", "w", entry)).toContain('"/work/My App"');
	});
});

describe("unreadable files", () => {
	it("refuses JSON with comments rather than rewrite it", () => {
		const jsonc = '{\n  // my servers\n  "servers": {}\n}';
		expect(() => entryState("vscode", jsonc, "w", entry)).toThrow(ConfigParseError);
		expect(() => withEntry("vscode", jsonc, "w", entry)).toThrow(ConfigParseError);
		expect(() => withEntry("mcp-servers", '{"mcpServers": []}', "w", entry)).toThrow(
			ConfigParseError,
		);
		expect(() => withEntry("mcp-servers", "[]", "w", entry)).toThrow(ConfigParseError);
	});

	it("refuses a hermes config that is not a mapping, or does not parse", () => {
		expect(() => entryState("hermes-yaml", "- a\n- b\n", "w", entry)).toThrow(ConfigParseError);
		expect(() => withEntry("hermes-yaml", "mcp_servers: [x]\n", "w", entry)).toThrow(
			ConfigParseError,
		);
		expect(() => entryState("hermes-yaml", "a: [unclosed\n", "w", entry)).toThrow(
			ConfigParseError,
		);
	});
});

describe("clientDefinitions", () => {
	it("puts each config where its client reads it", () => {
		const defs = clientDefinitions({ home: "/h", appData: "/ad", codexHome: "/cx" });
		const file = (id: string) => defs.find((d) => d.id === id)?.file.replaceAll("\\", "/");
		expect(file("claude-code")).toBe("/h/.claude.json");
		expect(file("codex")).toBe("/cx/config.toml");
		expect(file("gemini-cli")).toBe("/h/.gemini/settings.json");
		expect(file("copilot-cli")).toBe("/h/.copilot/mcp-config.json");
		expect(file("vscode")).toBe("/ad/Code/User/mcp.json");
		expect(file("cursor")).toBe("/h/.cursor/mcp.json");
		expect(file("claude-desktop")).toBe("/ad/Claude/claude_desktop_config.json");
		expect(file("windsurf")).toBe("/h/.codeium/windsurf/mcp_config.json");
		expect(file("opencode")).toBe("/h/.config/opencode/opencode.json");
		expect(file("hermes")).toBe("/h/.hermes/config.yaml");
		const custom = clientDefinitions({ home: "/h", appData: "/ad", hermesHome: "/hh" });
		expect(custom.find((d) => d.id === "hermes")?.file.replaceAll("\\", "/")).toBe(
			"/hh/config.yaml",
		);
	});
});
