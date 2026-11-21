import { useEffect, useMemo, useState } from "react";
import { AgentCliStatusBadge } from "./AgentCliStatusBadge";
import { ClaudeCodeStatusBadge } from "./ClaudeCodeStatusBadge";
import { CodexCliStatusBadge } from "./CodexCliStatusBadge";
import { CopilotCliStatusBadge } from "./CopilotCliStatusBadge";
import { HermesStatusBadge } from "./HermesStatusBadge";
import { ReaStatusBadge } from "./ReaStatusBadge";
import { type CliPresence, type CliToolId, orderCliTools } from "./cli-tool-order";
import {
	CliUpdateAllButton,
	type CliUpdateOffer,
	type CliUpdateOffers,
	type CliUpdateReporter,
} from "./cli-update-all";

interface CliToolBadgesProps {
	readonly isCollapsed: boolean;
	readonly onNavigateToTerminals: () => void;
	/** Each answer of a badge's check, for a summary shown elsewhere. */
	readonly onPresenceMapChange?: (presence: Readonly<Partial<Record<CliToolId, CliPresence>>>) => void;
}

export const CLI_TOOLS: readonly CliToolId[] = [
	"claude-code",
	"copilot",
	"codex",
	"opencode",
	"antigravity",
	"pi",
	"gemini-cli",
	"hermes",
	"rea",
];

/**
 * The sidebar's « Outils CLI » panel: one badge per agent CLI, the installed
 * ones first (an update available still counts as installed), then the
 * missing ones, each group in alphabetical order. Each badge runs its own
 * check and reports the answer here; keyed children move without remounting,
 * so an open popover or a running install survives a reorder. Each badge
 * with a newer release also hands its own update to the panel, whose foot
 * then offers to run them all.
 */
export function CliToolBadges({
	isCollapsed,
	onNavigateToTerminals,
	onPresenceMapChange,
}: CliToolBadgesProps) {
	const [presence, setPresence] = useState<Partial<Record<CliToolId, CliPresence>>>({});
	useEffect(() => onPresenceMapChange?.(presence), [onPresenceMapChange, presence]);

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

	const [offers, setOffers] = useState<CliUpdateOffers>({});
	const updateReporters = useMemo(
		() =>
			Object.fromEntries(
				CLI_TOOLS.map((id) => [
					id,
					(next: CliUpdateOffer | null) =>
						setOffers((prev) => {
							if ((prev[id] ?? null) === next) return prev;
							const copy: Partial<Record<CliToolId, CliUpdateOffer>> = { ...prev };
							if (next) copy[id] = next;
							else delete copy[id];
							return copy;
						}),
				]),
			) as Record<CliToolId, CliUpdateReporter>,
		[],
	);

	const ordered = orderCliTools(CLI_TOOLS, presence);

	const renderBadge = (id: CliToolId) => {
		const onPresenceChange = reporters[id];
		const onUpdateChange = updateReporters[id];
		switch (id) {
			case "claude-code":
				return (
					<ClaudeCodeStatusBadge
						key={id}
						onNavigateToTerminals={onNavigateToTerminals}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
						onUpdateChange={onUpdateChange}
					/>
				);
			case "copilot":
				return (
					<CopilotCliStatusBadge
						key={id}
						onNavigateToTerminals={onNavigateToTerminals}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
						onUpdateChange={onUpdateChange}
					/>
				);
			case "codex":
				return (
					<CodexCliStatusBadge
						key={id}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
						onUpdateChange={onUpdateChange}
					/>
				);
			case "hermes":
				return (
					<HermesStatusBadge
						key={id}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
						onUpdateChange={onUpdateChange}
					/>
				);
			case "rea":
				return (
					<ReaStatusBadge key={id} isCollapsed={isCollapsed} onPresenceChange={onPresenceChange} />
				);
			default:
				return (
					<AgentCliStatusBadge
						key={id}
						tool={id}
						isCollapsed={isCollapsed}
						onPresenceChange={onPresenceChange}
						onUpdateChange={onUpdateChange}
					/>
				);
		}
	};

	return (
		<div className="rounded-lg bg-white/4 border border-white/8 p-2 space-y-0.5 overflow-hidden">
			{ordered.map(renderBadge)}
			<CliUpdateAllButton order={ordered} offers={offers} />
		</div>
	);
}
