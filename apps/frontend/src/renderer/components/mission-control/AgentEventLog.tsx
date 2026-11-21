/**
 * AgentEventLog — Scrollable live event feed for Mission Control.
 *
 * Shows recent orchestrator events with timestamps, types, and agent references.
 * A live rebalancing (#344) says why and to which model; one not done, why not.
 */

import {
	Ban,
	CheckCircle2,
	Pause,
	Play,
	Plus,
	Repeat,
	RotateCcw,
	Settings2,
	Shuffle,
	Square,
	Trash2,
	XCircle,
} from "lucide-react";
import { useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { formatAppTime } from "@/lib/date-format";
import { cn } from "../../lib/utils";
import type { AgentSlot, MCEvent } from "../../stores/mission-control-store";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";

interface AgentEventLogProps {
	readonly events: MCEvent[];
	readonly agents: AgentSlot[];
}

const EVENT_ICONS: Record<MCEvent["type"], React.ElementType> = {
	agent_created: Plus,
	agent_removed: Trash2,
	agent_started: Play,
	agent_paused: Pause,
	agent_resumed: RotateCcw,
	agent_stopped: Square,
	agent_config_updated: Settings2,
	agent_completed: CheckCircle2,
	agent_failed: XCircle,
	agent_rebalanced: Shuffle,
	agent_rebalance_skipped: Ban,
	agent_loop_detected: Repeat,
};

const EVENT_COLORS: Record<MCEvent["type"], string> = {
	agent_created: "text-success",
	agent_removed: "text-destructive",
	agent_started: "text-blue-500",
	agent_paused: "text-warning",
	agent_resumed: "text-cyan-500",
	agent_stopped: "text-gray-500",
	agent_config_updated: "text-purple-500",
	agent_completed: "text-success",
	agent_failed: "text-destructive",
	agent_rebalanced: "text-warning",
	agent_rebalance_skipped: "text-muted-foreground",
	agent_loop_detected: "text-warning",
};

/** What a rebalancing event says beyond its title; null for other events. */
function rebalanceLine(event: MCEvent, t: TFunction): string | null {
	const { reason, action, skipped, from, to } = event.data;
	if (!reason) return null;
	const why = t(`missionControl:rebalance.reasons.${reason}`);
	if (event.type === "agent_rebalanced" && action) {
		return t("missionControl:rebalance.moved", {
			reason: why,
			action: t(`missionControl:rebalance.actions.${action}`),
			from,
			to,
		});
	}
	if (event.type === "agent_rebalance_skipped" && skipped) {
		return t("missionControl:rebalance.notMoved", {
			reason: why,
			skipped: t(`missionControl:rebalance.skipped.${skipped}`),
		});
	}
	return null;
}

export function AgentEventLog({ events, agents }: AgentEventLogProps) {
	const { t } = useTranslation();
	const agentMap = useMemo(() => {
		const map = new Map<string, string>();
		for (const a of agents) {
			map.set(a.id, a.name);
		}
		return map;
	}, [agents]);

	const reversedEvents = useMemo(() => [...events].reverse(), [events]);

	if (reversedEvents.length === 0) {
		return (
			<div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
				{t("missionControl:noEvents")}
			</div>
		);
	}

	return (
		<ScrollArea className="h-64">
			<div className="space-y-1 pr-2">
				{reversedEvents.map((event) => {
					const Icon = EVENT_ICONS[event.type];
					const { agent_id: agentId, error, task } = event.data;
					const detail = rebalanceLine(event, t);
					const timeStr = formatAppTime(new Date(event.timestamp * 1000), {
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
					});

					return (
						<div
							// Two agents can log the same event in the same instant: the agent keeps the key unique.
							key={`${event.timestamp}-${event.type}-${agentId}`}
							className="flex items-start gap-2 py-1 px-1.5 rounded text-xs hover:bg-muted/30 transition-colors"
						>
							<Icon className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", EVENT_COLORS[event.type])} />
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-1.5">
									<span className="font-medium">{t(`missionControl:events.${event.type}`)}</span>
									{/* A removed agent is still named by its id. */}
									<Badge variant="outline" className="text-3xs px-1 py-0">
										{agentMap.get(agentId) ?? agentId}
									</Badge>
								</div>
								{error && <p className="text-destructive truncate mt-0.5">{error}</p>}
								{task && <p className="text-muted-foreground truncate mt-0.5">{task}</p>}
								{detail && <p className="text-muted-foreground mt-0.5">{detail}</p>}
							</div>
							<span className="text-3xs text-muted-foreground shrink-0 tabular-nums">
								{timeStr}
							</span>
						</div>
					);
				})}
			</div>
		</ScrollArea>
	);
}
