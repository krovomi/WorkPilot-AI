/**
 * Mission Control: several agents at once, each with its provider and model,
 * their decision trees and a live event log.
 */

import { Activity, AlertTriangle, Brain, GitBranch, Plus, Power, PowerOff, RefreshCw, Rocket, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMissionControlStore } from "../../stores/mission-control-store";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	Section,
	Stat,
	Stats,
} from "../charter";
import { AddAgentDialog, AgentEventLog, AgentPanel, DecisionTreeViewer } from "./index";

const FEATURES = [
	{ key: "featureMultiAgent", icon: Users },
	{ key: "featureModelMixing", icon: Brain },
	{ key: "featureDecisionTree", icon: GitBranch },
	{ key: "featureLiveView", icon: Activity },
] as const;

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

export function MissionControlDashboard() {
	const { t } = useTranslation(["missionControl", "common", "navigation"]);
	const {
		session,
		isActive,
		agents,
		selectedAgentId,
		decisionTrees,
		events,
		isLoading,
		error,
		startSession,
		stopSession,
		fetchState,
		createAgent,
		removeAgent,
		startAgent,
		pauseAgent,
		resumeAgent,
		stopAgent,
		selectAgent,
		startPolling,
		stopPolling,
		updateAgentConfig,
	} = useMissionControlStore();

	const [showAddAgent, setShowAddAgent] = useState(false);

	// Poll while the session runs.
	useEffect(() => {
		if (isActive) startPolling();
		return () => stopPolling();
	}, [isActive, startPolling, stopPolling]);

	const selectedAgent = useMemo(
		() => agents.find((a) => a.id === selectedAgentId) ?? null,
		[agents, selectedAgentId],
	);
	const selectedTree = selectedAgentId ? (decisionTrees[selectedAgentId] ?? null) : null;

	const runningCount = agents.filter((a) => a.status === "running").length;
	const totalTokens = agents.reduce((sum, a) => sum + (a.tokens?.total_tokens ?? 0), 0);
	const totalCost = agents.reduce((sum, a) => sum + (a.tokens?.estimated_cost_usd ?? 0), 0);

	const handleAddAgent = async (name: string, role: string, provider: string, model: string, modelLabel: string) => {
		await createAgent(name, role, provider, model, modelLabel);
		setShowAddAgent(false);
	};

	const header = (actions: React.ReactNode) => (
		<ModuleHeader
			kicker={t("navigation:groups.workspace")}
			title={t("missionControl:title")}
			description={t("missionControl:launchDescription")}
			icon={Rocket}
			tone="orange"
			actions={actions}
		/>
	);

	// Before a session: what it does, and one button to launch it.
	if (!isActive) {
		return (
			<ModuleStage scroll="page" data-testid="mission-control-view">
				{header(
					<CharterButton
						variant="primary"
						icon={Power}
						busy={isLoading}
						onClick={() => void startSession()}
						disabled={isLoading}
					>
						{t("missionControl:launchSession")}
					</CharterButton>,
				)}
				<Page className="space-y-4">
					{error && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							{t("missionControl:launchError", { error })}
						</Notice>
					)}
					<Section kicker={t("missionControl:kickers.what")} title={t("missionControl:whatTitle")}>
						<div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
							{FEATURES.map(({ key, icon: Icon }) => (
								<Panel key={key} rail tone="orange" className="flex items-start gap-2.5">
									<Icon className="wp-ink mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
									<div className="min-w-0">
										<p className="wp-title text-sm">{t(`missionControl:${key}`)}</p>
										<p className="wp-meta mt-0.5">{t(`missionControl:featureHints.${key}`)}</p>
									</div>
								</Panel>
							))}
						</div>
					</Section>
				</Page>
			</ModuleStage>
		);
	}

	return (
		<ModuleStage scroll="page" data-testid="mission-control-view">
			{header(
				<>
					<CharterButton icon={RefreshCw} onClick={() => void fetchState()}>
						{t("common:buttons.refresh")}
					</CharterButton>
					<CharterButton icon={PowerOff} variant="danger" onClick={() => void stopSession()}>
						{t("missionControl:stopSession")}
					</CharterButton>
					<CharterButton variant="primary" icon={Plus} onClick={() => setShowAddAgent(true)}>
						{t("missionControl:addAgent")}
					</CharterButton>
				</>,
			)}
			<Page className="space-y-4">
				<div className="flex flex-wrap items-center gap-2">
					<span className="wp-kicker">{t("missionControl:session")}</span>
					<Chip tone="green">
						<span className="font-mono">{session?.session_id ?? "—"}</span>
					</Chip>
				</div>

				<Stats>
					<Stat
						label={t("missionControl:statAgents")}
						value={t("missionControl:agentsRunning", { running: runningCount, total: agents.length })}
						tone="blue"
					/>
					<Stat label={t("missionControl:statTokens")} value={totalTokens.toLocaleString()} tone="violet" />
					<Stat
						label={t("missionControl:statCost")}
						value={t("missionControl:costValue", { value: totalCost.toFixed(4) })}
						tone="green"
					/>
					<Stat
						label={t("missionControl:statElapsed")}
						value={formatElapsed(session?.elapsed_seconds ?? 0)}
						tone="orange"
					/>
				</Stats>

				{error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{error}
					</Notice>
				)}

				<Section kicker={t("missionControl:kickers.agents")} title={t("missionControl:statAgents")} meta={String(agents.length)}>
					{agents.length === 0 ? (
						<EmptyStage icon={Users} tone="orange" title={t("missionControl:noAgents")} />
					) : (
						<div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
							{agents.map((agent) => (
								<AgentPanel
									key={agent.id}
									agent={agent}
									isSelected={agent.id === selectedAgentId}
									onSelect={() => selectAgent(agent.id)}
									onStart={(task: string) => startAgent(agent.id, task)}
									onPause={() => pauseAgent(agent.id)}
									onResume={() => resumeAgent(agent.id)}
									onStop={() => stopAgent(agent.id)}
									onRemove={() => removeAgent(agent.id)}
									onShowDecisionTree={() => selectAgent(agent.id)}
									onUpdateConfig={(config: Record<string, unknown>) => updateAgentConfig(agent.id, config)}
								/>
							))}
						</div>
					)}
				</Section>

				{agents.length > 0 && (
					<div className="wp-split grid gap-4 lg:grid-cols-2">
						<Section
							kicker={t("missionControl:kickers.reasoning")}
							title={t("missionControl:decisionTree")}
							actions={selectedAgent ? <Chip tone="violet">{selectedAgent.name}</Chip> : undefined}
						>
							<Panel>
								{selectedTree ? (
									<DecisionTreeViewer tree={selectedTree} />
								) : (
									<p className="wp-meta py-8 text-center">{t("missionControl:selectAgentForTree")}</p>
								)}
							</Panel>
						</Section>
						<Section
							kicker={t("missionControl:kickers.live")}
							title={t("missionControl:eventLog")}
							meta={String(events.length)}
						>
							<Panel>
								<AgentEventLog events={events} agents={agents} />
							</Panel>
						</Section>
					</div>
				)}
			</Page>
			<AddAgentDialog open={showAddAgent} onOpenChange={setShowAddAgent} onAdd={handleAddAgent} />
		</ModuleStage>
	);
}
