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
 * How WorkPilot installs a CLI that is missing, from the vendor's own
 * channels: the npm package when there is one (and a Node.js recent enough
 * for it), else the vendor's install script. Each CLI still owns its sign-in.
 */
export interface AgentCliInstallRecipe {
	/** npm package installed globally, with its version tag. */
	npmPackage?: string;
	/** Extra `npm install -g` arguments the vendor documents. */
	npmArgs?: readonly string[];
	/** Lowest Node.js the npm package runs on, `major.minor`. */
	minNode?: string;
	/** Vendor install script for macOS and Linux, piped to the named shell. */
	unixScript?: { url: string; shell: "bash" | "sh" };
	/** Vendor PowerShell install script for Windows. */
	windowsScript?: string;
}

export const AGENT_CLI_INSTALL: Readonly<Record<AgentCliTool, AgentCliInstallRecipe>> = {
	opencode: {
		npmPackage: "opencode-ai@latest",
		unixScript: { url: "https://opencode.ai/install", shell: "bash" },
	},
	antigravity: {
		unixScript: { url: "https://antigravity.google/cli/install.sh", shell: "bash" },
		windowsScript: "https://antigravity.google/cli/install.ps1",
	},
	pi: {
		npmPackage: "@earendil-works/pi-coding-agent@latest",
		npmArgs: ["--ignore-scripts"],
		minNode: "22.19",
		unixScript: { url: "https://pi.dev/install.sh", shell: "sh" },
		windowsScript: "https://pi.dev/install.ps1",
	},
	"gemini-cli": {
		npmPackage: "@google/gemini-cli@latest",
		minNode: "20.0",
	},
};

/** Why an install did not end with the CLI found on PATH. */
export type AgentCliInstallError =
	/** Neither a usable npm nor a vendor script for this platform. */
	| "node_required"
	/** Every install method failed: `detail` holds the last output. */
	| "failed"
	/** The installer succeeded but the executable is still not found. */
	| "not_on_path"
	/** An install of this CLI is already running. */
	| "busy";

export interface AgentCliInstallResult {
	tool: AgentCliTool;
	success: boolean;
	/** Which channel installed it. */
	method?: "npm" | "script";
	/** The check run after the install. */
	status?: AgentCliStatus;
	error?: AgentCliInstallError;
	/** The tail of the failing command's output, for the user. */
	detail?: string;
}

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
