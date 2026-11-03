import { useEffect } from "react";
import type { AgentCliTool } from "../../shared/types/agent-cli";

/**
 * Whether a CLI of the sidebar's « Outils CLI » panel can be used: an
 * outdated CLI (update available) or a degraded one still counts as installed.
 */
export type CliPresence = "installed" | "missing";

/** The CLIs the panel lists, by a stable id. */
export type CliToolId = "claude-code" | "copilot" | "codex" | AgentCliTool | "hermes";

/** Names the badges show: proper nouns, identical in every language. */
export const AGENT_CLI_SHORT_NAMES: Readonly<Record<AgentCliTool, string>> = {
	opencode: "OpenCode",
	antigravity: "Antigravity",
	pi: "pi",
	"gemini-cli": "Gemini",
};

export const CLI_TOOL_NAMES: Readonly<Record<CliToolId, string>> = {
	"claude-code": "Claude Code",
	copilot: "Copilot",
	codex: "Codex",
	...AGENT_CLI_SHORT_NAMES,
	hermes: "Hermes",
};

/**
 * The panel's order: installed CLIs first, then the missing ones, each group
 * alphabetical whatever the case (« pi » sits among the P). A CLI whose check
 * has not answered yet stays with the installed ones, so nothing jumps down
 * until it is known to be missing.
 */
export function orderCliTools(
	tools: readonly CliToolId[],
	presence: Readonly<Partial<Record<CliToolId, CliPresence>>>,
): CliToolId[] {
	const rank = (id: CliToolId) => (presence[id] === "missing" ? 1 : 0);
	return [...tools].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			CLI_TOOL_NAMES[a].localeCompare(CLI_TOOL_NAMES[b], "en", { sensitivity: "base" }) ||
			a.localeCompare(b),
	);
}

/**
 * Tells the panel where a badge belongs once its check has answered. `null`
 * while checking: a refresh keeps the badge where it was instead of moving it.
 */
export function useReportCliPresence(
	onPresenceChange: ((presence: CliPresence) => void) | undefined,
	presence: CliPresence | null,
): void {
	useEffect(() => {
		if (presence) onPresenceChange?.(presence);
	}, [onPresenceChange, presence]);
}
