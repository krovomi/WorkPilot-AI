/**
 * One-click update of the CLIs of the sidebar's « Outils CLI » panel that do
 * not carry their own updater in WorkPilot (Claude Code, Copilot and Codex
 * do): the coding-agent CLIs (OpenCode, Antigravity, pi, Gemini CLI) and
 * hermes-agent.
 *
 * Hermes is listed here, not in `AgentCliTool`: it is not a provider a task is
 * handed to (`capabilities/harnesses.yaml`), only a CLI the person keeps up to
 * date.
 */

import type { AgentCliTool } from "./agent-cli";

export type UpdatableCliTool = AgentCliTool | "hermes";

export interface CliUpdateRecipe {
	/** The executable looked up on PATH. */
	executable: string;
	/**
	 * Where the latest release is published. Absent: the vendor publishes no
	 * version WorkPilot can read, so only its own updater knows.
	 */
	latest?: { npm: string } | { github: string };
	/** The npm package an npm-owned install is updated with. */
	npmPackage?: string;
	/** Extra `npm install -g` arguments the vendor documents. */
	npmArgs?: readonly string[];
	/** Homebrew formula, for an install Homebrew owns. */
	brewFormula?: string;
	/** The CLI's own updater: the arguments after its executable. */
	selfUpdate?: readonly string[];
}

/**
 * The vendors' own channels, in WorkPilot's constants: nothing the renderer
 * sends reaches a command line.
 * - OpenCode: `opencode upgrade` detects how it was installed (curl, npm,
 *   pnpm, bun, brew).
 * - Antigravity: `agy update`; Google publishes no version to compare with.
 * - pi: npm, or the installer script again (it installs the latest release).
 * - Gemini CLI: npm or Homebrew, its two channels.
 * - Hermes: `hermes update --yes` knows git, pip, nix and the desktop app;
 *   `--yes` accepts its migration prompts instead of waiting on a stdin
 *   nobody types into. Its stable channel is the latest GitHub release.
 */
export const CLI_UPDATE: Readonly<Record<UpdatableCliTool, CliUpdateRecipe>> = {
	opencode: {
		executable: "opencode",
		latest: { npm: "opencode-ai" },
		npmPackage: "opencode-ai@latest",
		brewFormula: "opencode",
		selfUpdate: ["upgrade"],
	},
	antigravity: {
		executable: "agy",
		selfUpdate: ["update"],
	},
	pi: {
		executable: "pi",
		latest: { npm: "@earendil-works/pi-coding-agent" },
		npmPackage: "@earendil-works/pi-coding-agent@latest",
		npmArgs: ["--ignore-scripts"],
	},
	"gemini-cli": {
		executable: "gemini",
		latest: { npm: "@google/gemini-cli" },
		npmPackage: "@google/gemini-cli@latest",
		brewFormula: "gemini-cli",
	},
	hermes: {
		executable: "hermes",
		latest: { github: "NousResearch/hermes-agent" },
		selfUpdate: ["update", "--yes"],
	},
};

export interface CliUpdateStatus {
	tool: UpdatableCliTool;
	installed: boolean;
	version?: string;
	/** The latest release, when the vendor publishes one and it could be read. */
	latest?: string;
	/** Only true when both versions are known and the installed one is older. */
	isOutdated: boolean;
}

export type CliUpdateError =
	/** The CLI is not on PATH: install it instead. */
	| "not_installed"
	/** No channel fits this install: `detail` says how to update it by hand. */
	| "no_method"
	/** Every channel failed: `detail` holds the last output. */
	| "failed"
	/** The updater succeeded but the CLI still reports an older version. */
	| "still_outdated"
	/** An install or update of this CLI is already running. */
	| "busy";

export interface CliUpdateResult {
	tool: UpdatableCliTool;
	success: boolean;
	method?: "npm" | "brew" | "self" | "script";
	/** The check run after the update. */
	status?: CliUpdateStatus;
	error?: CliUpdateError;
	/** The tail of the failing command's output, for the person. */
	detail?: string;
}

export function isUpdatableCliTool(value: unknown): value is UpdatableCliTool {
	return typeof value === "string" && Object.hasOwn(CLI_UPDATE, value);
}
