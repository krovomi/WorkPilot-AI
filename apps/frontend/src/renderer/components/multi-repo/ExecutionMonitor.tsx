import type { MultiRepoOrchestration, RepoExecutionStatus } from "@shared/types";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

interface ExecutionMonitorProps {
	readonly orchestration: MultiRepoOrchestration;
}

const STATUS_ICONS: Record<RepoExecutionStatus, string> = {
	pending: "○",
	coding: "●",
	qa: "◉",
	needs_you: "!",
	completed: "✓",
	failed: "✗",
};

/**
 * ExecutionMonitor - overall progress, what the run waits for, and one row
 * per repo in execution order, each naming the Kanban card it runs as.
 */
export function ExecutionMonitor({ orchestration }: ExecutionMonitorProps) {
	const { t } = useTranslation(["multiRepo"]);
	const { status, statusKey, statusRepo, overallProgress, executionOrder } = orchestration;
	const states = new Map(orchestration.repoStates.map((rs) => [rs.repo, rs]));
	const order = executionOrder.length > 0 ? executionOrder : [...states.keys()];

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<div className="flex items-center justify-between text-sm">
					<span className="font-medium text-foreground">{t(`multiRepo:status.${status}`)}</span>
					<span className="text-muted-foreground">{Math.round(overallProgress)}%</span>
				</div>
				<div
					className="h-2 w-full rounded-full bg-muted"
					role="progressbar"
					aria-label={t("multiRepo:execution.overall")}
					aria-valuenow={Math.round(overallProgress)}
					aria-valuemin={0}
					aria-valuemax={100}
				>
					<div
						className="h-2 rounded-full bg-primary transition-all duration-500"
						style={{ width: `${overallProgress}%` }}
					/>
				</div>
				{statusKey && (
					<p
						className={cn(
							"text-xs",
							status === "failed" ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{t(`multiRepo:${statusKey}`, { repo: statusRepo ?? "" })}
					</p>
				)}
			</div>

			<ol className="space-y-2">
				{order.map((repo) => {
					const rs = states.get(repo);
					if (!rs) return null;
					const isComplete = rs.status === "completed";
					const needsSomeone = rs.status === "needs_you" || rs.status === "failed";
					return (
						<li
							key={repo}
							className={cn(
								"flex items-center gap-3 rounded-lg border p-3 transition-colors",
								isComplete && "border-green-500/30 bg-green-500/5",
								needsSomeone && "border-amber-500/40 bg-amber-500/5",
								!isComplete && !needsSomeone && "border-border bg-card",
							)}
						>
							<span
								aria-hidden="true"
								className={cn(
									"w-4 text-center text-base",
									isComplete ? "text-green-500" : needsSomeone ? "text-amber-500" : "text-muted-foreground",
								)}
							>
								{STATUS_ICONS[rs.status]}
							</span>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate text-sm font-medium text-foreground">{repo}</span>
									<span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
										{t(`multiRepo:repoStatus.${rs.status}`)}
									</span>
								</div>
								<p className="mt-0.5 truncate text-xs text-muted-foreground">
									{rs.taskId
										? t("multiRepo:execution.card", { task: rs.taskId })
										: t("multiRepo:execution.noCardYet")}
								</p>
								{rs.branchName && (
									<p className="truncate text-xs text-muted-foreground">
										{t("multiRepo:execution.branch", { branch: rs.branchName })}
									</p>
								)}
								{rs.prUrl && (
									<p className="truncate text-xs text-primary">
										{t("multiRepo:execution.pr", { url: rs.prUrl })}
									</p>
								)}
							</div>
							<span className="w-10 text-right text-xs text-muted-foreground">
								{Math.round(rs.progress)}%
							</span>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
