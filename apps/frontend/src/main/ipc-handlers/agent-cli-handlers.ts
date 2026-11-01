/**
 * Agent CLI handlers — is OpenCode (`opencode`) / Google Antigravity (`agy`)
 * / pi (`pi`) installed, and which version.
 *
 * The backend drives the three as providers (`core/agent_clients/opencode_cli.py`,
 * `antigravity_cli.py`, `pi_cli.py`). Each CLI owns its login, so the only thing worth
 * checking from here is that the executable resolves and answers `--version`.
 * The tool name is validated against a closed list: nothing the renderer sends
 * reaches a command line.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	ACP_AGENT_ARGS,
	type AcpAgentDeclaration,
	AGENT_CLI_EXECUTABLES,
	type AgentCliStatus,
	type AgentCliTool,
	isAgentCliTool,
} from "../../shared/types/agent-cli";
import { getAugmentedEnv } from "../env-utils";
import { installAgentCli } from "./agent-cli-install";
import {
	findExecutable,
	getPathDelimiter,
	isSecurePath,
	requiresShell,
} from "../platform";

const execFileAsync = promisify(execFile);


const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

/** The first version-looking token of `--version` output, if any. */
export function extractAgentCliVersion(output: string): string | undefined {
	return VERSION_PATTERN.exec(output)?.[0];
}

async function readVersion(
	executable: string,
	env: Record<string, string>,
): Promise<string | undefined> {
	// A `.cmd` launcher (npm global install on Windows) only runs through
	// cmd.exe, and a command line built for cmd.exe from a PATH entry is a
	// command line nobody controls. Finding it is enough to say "installed";
	// its version stays unknown rather than paid for with a shell.
	if (requiresShell(executable) || !isSecurePath(executable)) {
		return undefined;
	}
	try {
		const result = await execFileAsync(executable, ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
			env,
		});
		return extractAgentCliVersion(`${result.stdout}\n${result.stderr}`);
	} catch {
		return undefined;
	}
}

export async function checkAgentCli(tool: unknown): Promise<AgentCliStatus> {
	if (!isAgentCliTool(tool)) {
		return { tool: "opencode", installed: false, error: "unknown tool" };
	}
	try {
		const env = getAugmentedEnv();
		const extraPaths = (env.PATH || "")
			.split(getPathDelimiter())
			.filter(Boolean);
		const executable = findExecutable(AGENT_CLI_EXECUTABLES[tool], extraPaths);
		if (!executable) return { tool, installed: false };
		const version = await readVersion(executable, env);
		return { tool, installed: true, version };
	} catch (error) {
		return {
			tool,
			installed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

const ACP_PROBE_TIMEOUT_MS = 15_000;

/** The `initialize` WorkPilot sends: the same offer as the backend client. */
const ACP_INITIALIZE = {
	jsonrpc: "2.0",
	id: 0,
	method: "initialize",
	params: {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: true }, terminal: false },
		clientInfo: { name: "workpilot", title: "WorkPilot AI" },
	},
};

/** What an `initialize` answer declares, read strictly: only `true` is yes. */
export function readAcpDeclaration(
	tool: AgentCliTool,
	result: unknown,
): AcpAgentDeclaration {
	if (!result || typeof result !== "object") return { tool, error: "not_acp" };
	const answer = result as Record<string, unknown>;
	if (answer.protocolVersion !== 1) return { tool, error: "not_acp" };
	const record = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const caps = record(answer.agentCapabilities);
	const prompt = record(caps.promptCapabilities);
	const mcp = record(caps.mcpCapabilities);
	const info = record(answer.agentInfo);
	const text = (value: unknown): string | undefined =>
		typeof value === "string" ? value.slice(0, 80) : undefined;
	const methods = Array.isArray(answer.authMethods) ? answer.authMethods : [];
	return {
		tool,
		declared: {
			name: text(info.title) ?? text(info.name),
			version: text(info.version),
			protocolVersion: 1,
			loadSession: caps.loadSession === true,
			images: prompt.image === true,
			audio: prompt.audio === true,
			embeddedContext: prompt.embeddedContext === true,
			mcpHttp: mcp.http === true,
			mcpSse: mcp.sse === true,
			authMethods: methods
				.map((method) => record(method).id)
				.filter((id): id is string => typeof id === "string")
				.map((id) => id.slice(0, 64))
				.slice(0, 10),
		},
	};
}

/**
 * Start the ACP agent, send `initialize`, read its declaration, stop it.
 * `initialize` needs no login (Gemini CLI answers it signed out). The tool is
 * one of a closed list and its arguments are WorkPilot's own.
 */
export async function probeAcpAgent(tool: unknown): Promise<AcpAgentDeclaration> {
	if (!isAgentCliTool(tool) || !ACP_AGENT_ARGS[tool]) {
		return { tool: "gemini-cli", error: "failed" };
	}
	const env = getAugmentedEnv();
	const extraPaths = (env.PATH || "").split(getPathDelimiter()).filter(Boolean);
	const executable = findExecutable(AGENT_CLI_EXECUTABLES[tool], extraPaths);
	if (!executable) return { tool, error: "not_installed" };
	if (requiresShell(executable) || !isSecurePath(executable)) {
		// The same reason as `readVersion`: no command line built for cmd.exe.
		return { tool, error: "shell_launcher" };
	}
	return new Promise<AcpAgentDeclaration>((resolve) => {
		let settled = false;
		let buffer = "";
		const child = spawn(executable, [...(ACP_AGENT_ARGS[tool] ?? [])], {
			env,
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		});
		const finish = (answer: AcpAgentDeclaration) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdin?.end();
			child.kill();
			resolve(answer);
		};
		const timer = setTimeout(() => finish({ tool, error: "no_answer" }), ACP_PROBE_TIMEOUT_MS);
		child.on("error", () => finish({ tool, error: "failed" }));
		child.on("close", () => finish({ tool, error: "no_answer" }));
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			if (buffer.length > 1_000_000) finish({ tool, error: "not_acp" });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				try {
					const message = JSON.parse(line) as Record<string, unknown>;
					if (message.id === 0 && "result" in message) {
						finish(readAcpDeclaration(tool, message.result));
						return;
					}
					if (message.id === 0 && "error" in message) {
						finish({ tool, error: "not_acp" });
						return;
					}
				} catch {
					// A line that is not JSON-RPC: keep reading until the timeout.
				}
			}
		});
		child.stdin?.write(`${JSON.stringify(ACP_INITIALIZE)}\n`);
	});
}

export function registerAgentCliHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.AGENT_CLI_CHECK, (_event, tool: unknown) =>
		checkAgentCli(tool),
	);
	ipcMain.handle(IPC_CHANNELS.AGENT_CLI_PROBE_ACP, (_event, tool: unknown) =>
		probeAcpAgent(tool),
	);
	ipcMain.handle(IPC_CHANNELS.AGENT_CLI_INSTALL, (_event, tool: unknown) =>
		installAgentCli(tool, checkAgentCli),
	);
}
