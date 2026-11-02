/**
 * Registering the board server in a fake home: written where each client
 * reads it, a first backup kept, Claude Code through its CLI, an unreadable
 * file left alone. Then the command written in a config is run as a client
 * would run it, and must answer MCP's `initialize`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBoardMcp, type BoardMcpContext, boardMcpStatus, buildEntry } from "../service";

const BACKEND = path.resolve(__dirname, "..", "..", "..", "..", "..", "backend");

let home: string;
let project: string;

function context(overrides: Partial<BoardMcpContext> = {}): BoardMcpContext {
	return {
		dirs: { home, appData: path.join(home, "AppData") },
		entry: buildEntry(["python3", []], BACKEND, project),
		projectName: "Demo App",
		claude: null,
		...overrides,
	};
}

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "board-mcp-home-"));
	project = mkdtempSync(path.join(os.tmpdir(), "board-mcp-project-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("buildEntry", () => {
	it("runs the runner isolated, for this project only", () => {
		const entry = buildEntry(["py", ["-3"]], "/app/backend", "/work/demo");
		expect(entry.command).toBe("py");
		expect(entry.args).toEqual([
			"-3",
			"-I",
			"-X",
			"utf8",
			path.join("/app/backend", "runners", "board_mcp.py"),
			"--project-dir",
			"/work/demo",
		]);
	});
});

describe("boardMcpStatus", () => {
	it("lists every client, writable only where the app is installed", () => {
		mkdirSync(path.join(home, ".cursor"));
		const status = boardMcpStatus(context());
		expect(status.serverName).toBe("workpilot-demo-app");
		expect(status.clients).toHaveLength(9);
		const cursor = status.clients.find((c) => c.id === "cursor");
		expect(cursor).toMatchObject({ detected: true, writable: true, state: "absent" });
		expect(cursor?.location.replaceAll("\\", "/")).toBe("~/.cursor/mcp.json");
		const windsurf = status.clients.find((c) => c.id === "windsurf");
		expect(windsurf).toMatchObject({ detected: false, writable: false });
		const claude = status.clients.find((c) => c.id === "claude-code");
		expect(claude?.writable).toBe(false);
	});
});

describe("applyBoardMcp", () => {
	it("writes, keeps a first backup, then removes", async () => {
		const file = path.join(home, ".gemini", "settings.json");
		mkdirSync(path.dirname(file));
		writeFileSync(file, JSON.stringify({ theme: "x" }), "utf-8");
		const added = await applyBoardMcp(context(), "gemini-cli", true);
		expect(added.state).toBe("current");
		const config = JSON.parse(readFileSync(file, "utf-8"));
		expect(config.theme).toBe("x");
		expect(config.mcpServers["workpilot-demo-app"].args).toContain(project);
		expect(readFileSync(`${file}.workpilot.bak`, "utf-8")).toBe(JSON.stringify({ theme: "x" }));
		expect(existsSync(`${file}.workpilot.tmp`)).toBe(false);

		const removed = await applyBoardMcp(context(), "gemini-cli", false);
		expect(removed.state).toBe("absent");
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ theme: "x", mcpServers: {} });
	});

	it("leaves an unreadable file as it is", async () => {
		const file = path.join(home, "AppData", "Code", "User", "mcp.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, "{ // mine\n}", "utf-8");
		const status = boardMcpStatus(context()).clients.find((c) => c.id === "vscode");
		expect(status).toMatchObject({ writable: false });
		expect(status?.readError).toBeTruthy();
		await expect(applyBoardMcp(context(), "vscode", true)).rejects.toThrow();
		expect(readFileSync(file, "utf-8")).toBe("{ // mine\n}");
	});

	it("refuses a client that is not installed", async () => {
		await expect(applyBoardMcp(context(), "windsurf", true)).rejects.toThrow("client_not_found");
		expect(existsSync(path.join(home, ".codeium"))).toBe(false);
	});

	it("goes through the claude CLI for Claude Code, replacing an old entry", async () => {
		mkdirSync(path.join(home, ".claude"));
		writeFileSync(
			path.join(home, ".claude.json"),
			JSON.stringify({ mcpServers: { "workpilot-demo-app": { command: "/old" } } }),
			"utf-8",
		);
		const claude = vi.fn().mockResolvedValue({ code: 0, output: "" });
		await applyBoardMcp(context({ claude }), "claude-code", true);
		expect(claude.mock.calls[0][0]).toEqual([
			"mcp",
			"remove",
			"--scope",
			"user",
			"workpilot-demo-app",
		]);
		expect(claude.mock.calls[1][0].slice(0, 2)).toEqual(["mcp", "add-json"]);
	});

	it("reports the claude CLI's own error", async () => {
		mkdirSync(path.join(home, ".claude"));
		const claude = vi.fn().mockResolvedValue({ code: 1, output: "boom" });
		await expect(applyBoardMcp(context({ claude }), "claude-code", true)).rejects.toThrow("boom");
	});
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("the command a client runs", () => {
	it("answers initialize and lists the board's tools", async () => {
		mkdirSync(path.join(home, ".cursor"));
		await applyBoardMcp(context(), "cursor", true);
		const config = JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf-8"));
		const server = config.mcpServers["workpilot-demo-app"];
		const child = spawn(server.command, server.args, { cwd: os.tmpdir() });
		const lines: string[] = [];
		let buffer = "";
		const done = new Promise<void>((resolve) => {
			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const parts = buffer.split("\n");
				buffer = parts.pop() ?? "";
				lines.push(...parts.filter(Boolean));
				if (lines.length >= 2) resolve();
			});
		});
		const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
		});
		send({ jsonrpc: "2.0", method: "notifications/initialized" });
		send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		await done;
		child.kill();
		expect(JSON.parse(lines[0]).result.serverInfo.name).toBe("workpilot-board");
		const tools = JSON.parse(lines[1]).result.tools.map((t: { name: string }) => t.name);
		expect(tools).toEqual(expect.arrayContaining(["list_cards", "create_card"]));
	}, 20_000);
});
