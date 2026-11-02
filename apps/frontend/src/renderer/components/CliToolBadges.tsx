import { AgentCliStatusBadge } from "./AgentCliStatusBadge";
import { ClaudeCodeStatusBadge } from "./ClaudeCodeStatusBadge";
import { CodexCliStatusBadge } from "./CodexCliStatusBadge";
import { CopilotCliStatusBadge } from "./CopilotCliStatusBadge";
import { HermesStatusBadge } from "./HermesStatusBadge";

interface CliToolBadgesProps {
	readonly isCollapsed: boolean;
	readonly onNavigateToTerminals: () => void;
}

/**
 * The sidebar's « Outils CLI » panel: one badge per agent CLI. The coding
 * agents WorkPilot drives come first; Hermes, which learns beside them rather
 * than taking tasks, closes the list.
 */
export function CliToolBadges({ isCollapsed, onNavigateToTerminals }: CliToolBadgesProps) {
	return (
		<div className="rounded-lg bg-white/4 border border-white/8 p-2 space-y-0.5 overflow-hidden">
			<ClaudeCodeStatusBadge
				onNavigateToTerminals={onNavigateToTerminals}
				isCollapsed={isCollapsed}
			/>
			<CopilotCliStatusBadge
				onNavigateToTerminals={onNavigateToTerminals}
				isCollapsed={isCollapsed}
			/>
			<CodexCliStatusBadge
				onNavigateToTerminals={onNavigateToTerminals}
				isCollapsed={isCollapsed}
			/>
			<AgentCliStatusBadge tool="opencode" isCollapsed={isCollapsed} />
			<AgentCliStatusBadge tool="antigravity" isCollapsed={isCollapsed} />
			<AgentCliStatusBadge tool="pi" isCollapsed={isCollapsed} />
			<AgentCliStatusBadge tool="gemini-cli" isCollapsed={isCollapsed} />
			<HermesStatusBadge isCollapsed={isCollapsed} />
		</div>
	);
}
