/**
 * Coding-agent CLIs WorkPilot drives as providers (OpenCode, Google
 * Antigravity, pi, and the Agent Client Protocol agents such as Gemini CLI).
 * Each owns its own login; WorkPilot only checks that the binary is on PATH,
 * which version it reports and, for an ACP agent, what it declares.
 */

/** The provider id, which is also the key `checkAgentCli` takes. */
export type AgentCliTool = "opencode" | "antigravity" | "pi" | "gemini-cli";

/** The executable each tool is found under. */
export const AGENT_CLI_EXECUTABLES: Readonly<Record<AgentCliTool, string>> = {
	opencode: "opencode",
	antigravity: "agy",
	pi: "pi",
	"gemini-cli": "gemini",
};

/** Where a user learns to install and sign in to each CLI. */
export const AGENT_CLI_DOCS: Readonly<Record<AgentCliTool, string>> = {
	opencode: "https://opencode.ai/docs/cli",
	antigravity: "https://antigravity.google/docs/cli/headless/",
	pi: "https://pi.dev/docs/latest/quickstart",
	"gemini-cli": "https://geminicli.com/docs/cli/acp-mode/",
};

/**
 * How each ACP agent is started: the arguments after its executable, as
 * `capabilities/providers.yaml` writes them in its `acp.command`
 * (`tests/test_acp_frontend_parity.py` keeps the two equal).
 */
export const ACP_AGENT_ARGS: Readonly<Partial<Record<AgentCliTool, readonly string[]>>> = {
	"gemini-cli": ["--acp"],
};

/** What an ACP agent declared in `initialize`, read by `probeAcpAgent`. */
export interface AcpAgentDeclaration {
	tool: AgentCliTool;
	/** Set when the agent answered `initialize`. */
	declared?: {
		name?: string;
		version?: string;
		protocolVersion: number;
		loadSession: boolean;
		images: boolean;
		audio: boolean;
		embeddedContext: boolean;
		mcpHttp: boolean;
		mcpSse: boolean;
		/** Login method ids it offers. */
		authMethods: string[];
	};
	/** Why there is no declaration: not installed, no answer, not ACP v1… */
	error?: "not_installed" | "not_acp" | "no_answer" | "shell_launcher" | "failed";
}

export interface AgentCliStatus {
	tool: AgentCliTool;
	installed: boolean;
	/** First version-looking token `--version` printed, when it printed one. */
	version?: string;
	/** Set when the check itself failed (not when the CLI is simply absent). */
	error?: string;
}

export function isAgentCliTool(value: unknown): value is AgentCliTool {
	return (
		value === "opencode" ||
		value === "antigravity" ||
		value === "pi" ||
		value === "gemini-cli"
	);
}
