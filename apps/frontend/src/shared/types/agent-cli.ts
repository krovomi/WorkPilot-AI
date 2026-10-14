/**
 * Coding-agent CLIs WorkPilot drives as providers (OpenCode, Google
 * Antigravity). Each owns its own login; WorkPilot only checks that the binary
 * is on PATH and which version it reports.
 */

/** The provider id, which is also the key `checkAgentCli` takes. */
export type AgentCliTool = "opencode" | "antigravity";

/** The executable each tool is found under. */
export const AGENT_CLI_EXECUTABLES: Readonly<Record<AgentCliTool, string>> = {
	opencode: "opencode",
	antigravity: "agy",
};

/** Where a user learns to install and sign in to each CLI. */
export const AGENT_CLI_DOCS: Readonly<Record<AgentCliTool, string>> = {
	opencode: "https://opencode.ai/docs/cli",
	antigravity: "https://antigravity.google/docs/cli/headless/",
};

export interface AgentCliStatus {
	tool: AgentCliTool;
	installed: boolean;
	/** First version-looking token `--version` printed, when it printed one. */
	version?: string;
	/** Set when the check itself failed (not when the CLI is simply absent). */
	error?: string;
}

export function isAgentCliTool(value: unknown): value is AgentCliTool {
	return value === "opencode" || value === "antigravity";
}
