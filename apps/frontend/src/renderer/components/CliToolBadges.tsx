import { useMemo, useState } from "react";
import { AgentCliStatusBadge } from "./AgentCliStatusBadge";
import { ClaudeCodeStatusBadge } from "./ClaudeCodeStatusBadge";
import { CodexCliStatusBadge } from "./CodexCliStatusBadge";
import { CopilotCliStatusBadge } from "./CopilotCliStatusBadge";
import { HermesStatusBadge } from "./HermesStatusBadge";
import { type CliPresence, type CliToolId, orderCliTools } from "./cli-tool-order";

interface CliToolBadgesProps {
	readonly isCollapsed: boolean;
	readonly onNavigateToTerminals: () => void;
}

const CLI_TOOLS: readonly CliToolId[] = [
	"claude-code",
	"copilot",
	"codex",
	"opencode",
	"antigravity",
	"pi",
	"gemini-cli",
	"hermes",
];

/**
 * The sidebar's « Outils CLI » panel: one badge per agent CLI, the installed
 * ones first (an update available still counts as installed), then the
 * missing ones, each group in alphabetical order. Each badge runs its own
 * check and reports the answer here; keyed children move without remounting,
 * so an open popover or a running install survives a reorder.
 */
export function CliToolBadges({ isCollapsed, onNavigateToTerminals }: CliToolBadgesProps) {
	const [presence, setPresence] = useState<Partial<Record<CliToolId, CliPresence>>>({});

	const reporters = useMemo(
		() =>
			Object.fromEntries(
				CLI_TOOLS.map((id) => [
					id,
					(next: CliPresence) =>
						setPresence((prev) => (prev[id] === next ? prev : { ...prev, [id]: next })),
				]),
			) as Record<CliToolId, (next: CliPresence) => void>,
		[],
	);

	const ordered = orderCliTools(CLI_TOOLS, presence);

	const renderBadge = (id: CliToolId) => {
		const onPresenceChange = reporters[id];
		switch (id) {
			case "claude-code":
				return (
					<ClaudeCodeStatusBadge
						key={id}
						onNavigateToTerminals={onNavigateToTerminals}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
					/>
				);
			case "copilot":
				return (
					<CopilotCliStatusBadge
						key={id}
						onNavigateToTerminals={onNavigateToTerminals}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
					/>
				);
			case "codex":
				return (
					<CodexCliStatusBadge
						key={id}
						onNavigateToTerminals={onNavigateToTerminals}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
					/>
				);
			case "hermes":
				return (
					<HermesStatusBadge
						key={id}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
					/>
				);
			default:
				return (
					<AgentCliStatusBadge
						key={id}
						tool={id}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
					/>
				);
		}
	};

	return (
		<div className="rounded-lg bg-white/4 border border-white/8 p-2 space-y-0.5 overflow-hidden">
			{ordered.map(renderBadge)}
		</div>
	);
}
