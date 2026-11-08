import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type CICDProvider,
	type PipelineRunStatus,
	useCICDTriggersStore,
} from "../../stores/cicd-triggers-store";
import { useProjectStore } from "../../stores/project-store";
import { formatAppDateTime } from "@/lib/date-format";
import { AlertTriangle, Play, RefreshCw, Rocket, Workflow } from "lucide-react";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	type Tone,
} from "../charter";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Switch } from "../ui/switch";
const PROVIDERS: Exclude<CICDProvider, "">[] = [
	"github",
	"gitlab",
	"azure",
	"jenkins",
];

const STATUS_TONES: Record<PipelineRunStatus, Tone> = {
	pending: "muted",
	triggered: "blue",
	running: "amber",
	success: "green",
	failed: "red",
};

export function CICDTriggersDashboard(): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers", "navigation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const {
		config,
		runs,
		isLoading,
		isTriggering,
		error,
		loadConfig,
		setConfig,
		loadRuns,
		triggerPipeline,
		clearError,
	} = useCICDTriggersStore();

	const [branch, setBranch] = useState("");
	const [prUrl, setPrUrl] = useState("");

	useEffect(() => {
		if (!projectPath) return;
		loadConfig(projectPath);
		loadRuns(projectPath);
	}, [projectPath, loadConfig, loadRuns]);

	const provider = config?.provider ?? "";

	function handleTrigger() {
		if (!projectPath || !provider) return;
		triggerPipeline(projectPath, {
			provider,
			branch: branch.trim() || undefined,
			prUrl: prUrl.trim() || undefined,
		});
	}

	const toggles = [
		["enabled", "cicdTriggers:config.enabled"],
		["trigger_on_pr", "cicdTriggers:config.onPr"],
		["trigger_on_merge", "cicdTriggers:config.onMerge"],
	] as const;

	return (
		<ModuleStage data-testid="cicd-triggers-view">
			<ModuleHeader
				kicker={t("navigation:groups.gitIntegrations")}
				title={t("cicdTriggers:title")}
				description={t("cicdTriggers:subtitle")}
				icon={Workflow}
				tone="blue"
				actions={
					<CharterButton
						variant="ghost"
						icon={RefreshCw}
						busy={isLoading}
						onClick={() => projectPath && loadRuns(projectPath)}
						disabled={!projectPath || isLoading}
					>
						{t("cicdTriggers:actions.refresh")}
					</CharterButton>
				}
			/>

			{!activeProject ? (
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					<EmptyStage icon={Workflow} title={t("cicdTriggers:title")} tone="blue">
						{t("cicdTriggers:empty.noProject")}
					</EmptyStage>
				</div>
			) : (
				<>
					<Columns template="minmax(0, 1fr) minmax(0, 2fr)">
						<Column
							kicker={t("cicdTriggers:kickers.setup")}
							title={t("cicdTriggers:config.heading")}
							tone="blue"
						>
							<Panel className="space-y-3">
								<div className="space-y-1.5">
									<label htmlFor="cicd-provider" className="wp-kicker block">
										{t("cicdTriggers:config.provider")}
									</label>
									<NativeSelect
										id="cicd-provider"
										value={provider}
										onChange={(e) =>
											projectPath &&
											setConfig(projectPath, {
												provider: e.target.value as CICDProvider,
											})
										}
										className="h-auto w-full px-2 py-1.5 text-sm"
									>
										<option value="">{t("cicdTriggers:config.noProvider")}</option>
										{PROVIDERS.map((p) => (
											<option key={p} value={p}>
												{t(`cicdTriggers:providers.${p}`)}
											</option>
										))}
									</NativeSelect>
								</div>
								{toggles.map(([key, label]) => (
									<label
										key={key}
										htmlFor={`cicd-${key}`}
										className="flex cursor-pointer items-center justify-between gap-3 text-sm"
									>
										{t(label)}
										<Switch
											id={`cicd-${key}`}
											checked={config?.[key] ?? false}
											onCheckedChange={(checked) =>
												projectPath && setConfig(projectPath, { [key]: checked })
											}
										/>
									</label>
								))}
							</Panel>
						</Column>

						<Column
							kicker={t("cicdTriggers:kickers.history")}
							title={t("cicdTriggers:runs.heading", { count: runs.length })}
						>
							{error && (
								<Notice tone="red" icon={AlertTriangle} role="alert">
									<span className="flex items-start justify-between gap-3">
										<span>{error}</span>
										<CharterButton size="sm" variant="ghost" onClick={clearError}>
											{t("cicdTriggers:actions.dismiss")}
										</CharterButton>
									</span>
								</Notice>
							)}
							{runs.length === 0 ? (
								<EmptyStage icon={Rocket} title={t("cicdTriggers:empty.title")} tone="blue">
									{t("cicdTriggers:empty.body")}
								</EmptyStage>
							) : (
								<div className="grid gap-2.5">
									{runs.map((run) => (
										<Panel key={run.id} rail tone={STATUS_TONES[run.status] ?? "muted"}>
											<div className="flex items-start justify-between gap-2">
												<span className="wp-title text-sm">
													{run.branch || t("cicdTriggers:runs.noBranch")}
												</span>
												<Chip tone={STATUS_TONES[run.status] ?? "muted"}>
													{t(`cicdTriggers:status.${run.status}`, run.status)}
												</Chip>
											</div>
											<div className="wp-meta mt-1">
												{t(`cicdTriggers:providers.${run.provider}`, {
													defaultValue: run.provider,
												})}
												{" · "}
												{formatAppDateTime(run.triggered_at)}
											</div>
											{run.pr_url && (
												<div className="wp-muted mt-1 break-all font-mono text-xs">
													{run.pr_url}
												</div>
											)}
											{run.error && (
												<div className="mt-1 text-xs text-destructive">{run.error}</div>
											)}
										</Panel>
									))}
								</div>
							)}
						</Column>
					</Columns>

					<Composer
						prompt={
							<>
								<Input
									id="cicd-branch"
									type="text"
									value={branch}
									onChange={(e) => setBranch(e.target.value)}
									placeholder={t("cicdTriggers:trigger.branchPlaceholder")}
									aria-label={t("cicdTriggers:trigger.branch")}
									className="h-8 w-48 font-mono text-xs"
								/>
								<Input
									id="cicd-pr-url"
									type="text"
									value={prUrl}
									onChange={(e) => setPrUrl(e.target.value)}
									placeholder={t("cicdTriggers:trigger.prUrlPlaceholder")}
									aria-label={t("cicdTriggers:trigger.prUrl")}
									className="h-8 min-w-0 flex-1 font-mono text-xs"
								/>
							</>
						}
						actions={
							<CharterButton
								variant="primary"
								icon={Play}
								busy={isTriggering}
								onClick={handleTrigger}
								disabled={!provider || isTriggering}
							>
								{isTriggering
									? t("cicdTriggers:actions.triggering")
									: t("cicdTriggers:actions.trigger")}
							</CharterButton>
						}
						hint={
							provider
								? t("cicdTriggers:trigger.heading")
								: t("cicdTriggers:trigger.selectProviderFirst")
						}
					/>
				</>
			)}
		</ModuleStage>
	);
}

export default CICDTriggersDashboard;
