import { AlertTriangle, GitBranch, History, RotateCcw, Scissors, X } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { SurgeryPlan } from "../../../shared/types/git-surgeon";
import { useGitSurgeonStore } from "../../stores/git-surgeon-store";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Section,
	Stat,
	Stats,
	type Tone,
} from "../charter";

const SEVERITY_TONES: Record<string, Tone> = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "blue",
	info: "muted",
};

interface GitSurgeonDashboardProps {
	readonly projectPath?: string;
}

/** Finds what weighs on a repository's history and plans the clean-up. */
export function GitSurgeonDashboard({
	projectPath,
}: GitSurgeonDashboardProps): React.ReactElement {
	const { t } = useTranslation(["gitSurgeon", "navigation"]);

	const phase = useGitSurgeonStore((s) => s.phase);
	const status = useGitSurgeonStore((s) => s.status);
	const plan = useGitSurgeonStore((s) => s.plan);
	const error = useGitSurgeonStore((s) => s.error);
	const startScan = useGitSurgeonStore((s) => s.startScan);
	const cancelScan = useGitSurgeonStore((s) => s.cancelScan);
	const reset = useGitSurgeonStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const canRun = !!projectPath && !isScanning;

	return (
		<ModuleStage scroll="page" data-testid="git-surgeon-view">
			<ModuleHeader
				kicker={t("navigation:groups.gitIntegrations")}
				title={t("gitSurgeon:title")}
				description={t("gitSurgeon:description")}
				icon={Scissors}
				tone="violet"
				actions={
					<>
						{plan && !isScanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("gitSurgeon:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={X} onClick={() => cancelScan()}>
								{t("gitSurgeon:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={History}
								onClick={() => projectPath && startScan(projectPath)}
								disabled={!canRun}
							>
								{t("gitSurgeon:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>

			<Page className="space-y-4 pt-1">
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("gitSurgeon:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("gitSurgeon:actions.scanning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("gitSurgeon:errors.failed", { error })}
					</Notice>
				)}
				{plan ? (
					<ReportBody plan={plan} />
				) : (
					phase === "idle" && (
						<div className="flex justify-center py-8">
							<EmptyStage icon={GitBranch} title={t("gitSurgeon:emptyTitle")} tone="violet">
								{t("gitSurgeon:noData")}
							</EmptyStage>
						</div>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

function ReportBody({ plan }: { readonly plan: SurgeryPlan }): React.ReactElement {
	const { t } = useTranslation("gitSurgeon");
	return (
		<>
			<Stats>
				<Stat label={t("issues")} value={plan.issues.length} tone="violet" />
				<Stat
					label={t("savings")}
					value={`${plan.estimatedSizeSavingsMb.toFixed(1)} MB`}
					tone="green"
				/>
				<Stat label={t("plannedActions")} value={plan.actions.length} />
			</Stats>

			{plan.requiresForcePush && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{t("forcePushWarning")}
				</Notice>
			)}

			{plan.issues.length > 0 && (
				<Section kicker={t("kickers.issues")} title={t("issuesTitle")} tone="violet">
					<div className="grid gap-2.5">
						{plan.issues.map((issue) => {
							const tone = SEVERITY_TONES[issue.severity.toLowerCase()] ?? "amber";
							return (
								<Panel key={`${issue.commitSha}-${issue.filePath}`} rail tone={tone}>
									<div className="wp-chips">
										<Chip tone={tone}>{issue.severity}</Chip>
										<Chip tone="muted" dot={false}>
											{t(`issueTypes.${issue.issueType}`)}
										</Chip>
									</div>
									<p className="mt-2 text-sm">{issue.description}</p>
									<div className="wp-meta mt-1.5 flex flex-wrap items-center gap-3">
										<span className="font-mono">{issue.commitSha.slice(0, 8)}</span>
										{issue.filePath && <span className="font-mono">{issue.filePath}</span>}
										{issue.sizeBytes > 0 && (
											<span>{(issue.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
										)}
									</div>
								</Panel>
							);
						})}
					</div>
				</Section>
			)}

			{plan.actions.length > 0 && (
				<Section kicker={t("kickers.actions")} title={t("plannedActions")}>
					<div className="grid gap-2">
						{plan.actions.map((action) => (
							<Panel key={action.action} className="flex items-center gap-3 py-2.5">
								<Chip tone="violet" dot={false}>
									{action.action}
								</Chip>
								<span className="text-sm">{action.description}</span>
							</Panel>
						))}
					</div>
				</Section>
			)}

			{plan.summary && <p className="wp-muted text-sm">{plan.summary}</p>}
		</>
	);
}
