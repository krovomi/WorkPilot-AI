/**
 * #3.11 Agent Health Monitor panel.
 *
 * Scores each agent (planner, coder, QA) on each provider and model from the
 * project's own Kanban tasks: the backend reads their `task_logs.json`. It used
 * to show an in-memory monitor nothing ever fed, so it always said "no run".
 */

import { useEffect } from "react";
import type { ProjectAgentHealthPending } from "../../../preload/api/modules/phase35-features-api";
import { useTranslation } from "react-i18next";
import { useAgentHealthStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PanelShell } from "./_panel-shell";

const STATUS_COLOR: Record<string, string> = {
	healthy: "bg-success/20 text-success border-success/40",
	degraded: "bg-warning/20 text-warning border-warning/40",
	failing: "bg-orange-500/20 text-orange-700 border-orange-500/40",
	burned_out: "bg-destructive/20 text-destructive border-destructive/40",
};

function ModelName({ provider, model }: Pick<ProjectAgentHealthPending, "provider" | "model">) {
	const { t } = useTranslation("phase35");
	if (!provider && !model) {
		return <span className="text-xs text-muted-foreground">{t("agentHealth.unknownModel")}</span>;
	}
	return <code className="text-xs">{[provider, model].filter(Boolean).join(" · ")}</code>;
}

interface AgentHealthPanelProps {
	projectPath?: string;
}

export function AgentHealthPanel({ projectPath = "" }: AgentHealthPanelProps) {
	const { t } = useTranslation("phase35");
	const { phase, error, health, refresh } = useAgentHealthStore();

	useEffect(() => {
		if (projectPath) refresh(projectPath);
	}, [projectPath, refresh]);

	const isRunning = phase === "running";
	const scores = health?.scores ?? [];
	const pending = health?.pending ?? [];

	return (
		<PanelShell
			title={t("agentHealth.title")}
			subtitle={t("agentHealth.subtitle")}
			error={error}
			actions={
				<Button
					size="sm"
					variant="outline"
					onClick={() => refresh(projectPath)}
					disabled={isRunning || !projectPath}
				>
					{t("agentHealth.refresh")}
				</Button>
			}
		>
			{!projectPath && <p className="text-sm text-muted-foreground">{t("agentHealth.noProject")}</p>}
			{health && (
				<p className="mb-3 text-xs text-muted-foreground">
					{t("agentHealth.source", { count: health.tasks_read })}
				</p>
			)}
			{health && scores.length === 0 && pending.length === 0 && !isRunning && (
				<p className="text-sm text-muted-foreground">{t("agentHealth.noAgents")}</p>
			)}
			<ul className="space-y-3">
				{scores.map((s) => (
					<li key={s.agent_name} className="rounded border p-3">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-3">
								<span className="font-medium">{t(`agentHealth.roles.${s.role}` as never)}</span>
								<ModelName provider={s.provider} model={s.model} />
								<Badge className={STATUS_COLOR[s.status] ?? "bg-muted"}>
									{t(`agentHealth.status${s.status[0].toUpperCase()}${s.status.slice(1).replace("_o", "O")}` as never)}
								</Badge>
								<span className="text-2xl font-bold">{s.score.toFixed(0)}</span>
							</div>
							<span className="text-xs text-muted-foreground">
								{s.runs_in_window} {t("agentHealth.runs")} · {t(`agentHealth.trend${s.trend[0].toUpperCase()}${s.trend.slice(1)}` as never)}
							</span>
						</div>
						<div className="mt-2 grid grid-cols-4 gap-2 text-xs text-muted-foreground">
							<span>{t("agentHealth.successRate")}: {(s.success_rate * 100).toFixed(0)}%</span>
							<span>{t("agentHealth.errorRate")}: {(s.error_rate * 100).toFixed(0)}%</span>
							<span>{t("agentHealth.retryRate")}: {(s.retry_rate * 100).toFixed(0)}%</span>
							<span>{t("agentHealth.slowness")}: {s.slowness_ratio.toFixed(2)}×</span>
						</div>
						{s.actions.length > 0 && s.actions[0] !== "none" && (
							<div className="mt-2 flex flex-wrap gap-1">
								<span className="text-xs text-muted-foreground mr-2">{t("agentHealth.actions")}:</span>
								{s.actions.map((a) => (
									<Badge key={a} variant="outline" className="text-xs">
										{t(`agentHealth.actionLabels.${a}` as never, { defaultValue: a })}
									</Badge>
								))}
							</div>
						)}
					</li>
				))}
			</ul>
			{pending.length > 0 && (
				<div className="mt-4">
					<p className="text-xs font-medium text-muted-foreground">
						{t("agentHealth.pendingTitle", { min: health?.min_runs ?? 3 })}
					</p>
					<ul className="mt-1 space-y-1 text-xs text-muted-foreground">
						{pending.map((p) => (
							<li key={p.agent_name} className="flex flex-wrap items-center gap-2">
								<span>{t(`agentHealth.roles.${p.role}` as never)}</span>
								<ModelName provider={p.provider} model={p.model} />
								<span>{t("agentHealth.pendingRuns", { count: p.runs })}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</PanelShell>
	);
}
