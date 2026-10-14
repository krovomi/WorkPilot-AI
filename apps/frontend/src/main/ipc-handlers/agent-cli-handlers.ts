/**
 * Agent CLI handlers — is OpenCode (`opencode`) / Google Antigravity (`agy`)
 * installed, and which version.
 *
 * The backend drives both as providers (`core/agent_clients/opencode_cli.py`,
 * `antigravity_cli.py`). Each CLI owns its login, so the only thing worth
 * checking from here is that the executable resolves and answers `--version`.
 * The tool name is validated against a closed list: nothing the renderer sends
 * reaches a command line.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import {
	AGENT_CLI_EXECUTABLES,
	type AgentCliStatus,
	isAgentCliTool,
} from "../../shared/types/agent-cli";
import { getAugmentedEnv } from "../env-utils";
import { findExecutable, getPathDelimiter, requiresShell } from "../platform";

const execFileAsync = promisify(execFile);

export const AGENT_CLI_CHECK_CHANNEL = "agentCli:check";

const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

/** The first version-looking token of `--version` output, if any. */
export function extractAgentCliVersion(output: string): string | undefined {
	return VERSION_PATTERN.exec(output)?.[0];
}

async function readVersion(
	executable: string,
	env: Record<string, string>,
): Promise<string | undefined> {
	const options = {
		encoding: "utf-8" as const,
		timeout: 5000,
		windowsHide: true,
		env,
	};
	try {
		// A `.cmd` launcher (npm global install on Windows) needs cmd.exe. The
		// path comes from our own PATH search, never from the renderer.
		const result = requiresShell(executable)
			? await execFileAsync(
					env.ComSpec || process.env.ComSpec || "cmd.exe",
					["/d", "/s", "/c", `""${executable}" --version"`],
					options,
				)
			: await execFileAsync(executable, ["--version"], options);
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

export function registerAgentCliHandlers(): void {
	ipcMain.handle(AGENT_CLI_CHECK_CHANNEL, (_event, tool: unknown) =>
		checkAgentCli(tool),
	);
}
