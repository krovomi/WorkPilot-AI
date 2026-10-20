import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type CICDProvider,
	type PipelineRunStatus,
	useCICDTriggersStore,
} from "../../stores/cicd-triggers-store";
import { useProjectStore } from "../../stores/project-store";

const PROVIDERS: Exclude<CICDProvider, "">[] = [
	"github",
	"gitlab",
	"azure",
	"jenkins",
];

const STATUS_COLORS: Record<PipelineRunStatus, string> = {
	pending: "text-[var(--text-secondary)] bg-[var(--bg-secondary)]",
	triggered: "text-blue-400 bg-blue-500/10 border-blue-500/20",
	running: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
	success: "text-green-400 bg-green-500/10 border-green-500/20",
	failed: "text-red-400 bg-red-500/10 border-red-500/20",
};

export function CICDTriggersDashboard(): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
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

	return (
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			{/* Header */}
			<div className="px-6 py-4 border-b border-[var(--border-color)]">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-xl font-semibold">{t("cicdTriggers:title")}</h1>
						<p className="text-sm text-[var(--text-secondary)] mt-0.5">
							{t("cicdTriggers:subtitle")}
						</p>
					</div>
					<button
						type="button"
						onClick={() => projectPath && loadRuns(projectPath)}
						disabled={!projectPath || isLoading}
						className="px-3 py-2 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
					>
						{t("cicdTriggers:actions.refresh")}
					</button>
				</div>
			</div>

			{!activeProject ? (
				<div className="flex-1 flex items-center justify-center text-center p-8">
					<p className="text-sm text-[var(--text-secondary)] max-w-sm">
						{t("cicdTriggers:empty.noProject")}
					</p>
				</div>
			) : (
				<div className="flex flex-1 overflow-hidden">
					{/* Left: provider + trigger */}
					<div className="w-72 border-r border-[var(--border-color)] p-4 flex flex-col gap-5 overflow-auto">
						<div>
							<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">
								{t("cicdTriggers:config.heading")}
							</h3>
							<label
								htmlFor="cicd-provider"
								className="block text-xs text-[var(--text-secondary)] mb-1"
							>
								{t("cicdTriggers:config.provider")}
							</label>
							<select
								id="cicd-provider"
								value={provider}
								onChange={(e) =>
									projectPath &&
									setConfig(projectPath, {
										provider: e.target.value as CICDProvider,
									})
								}
								className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-sm"
							>
								<option value="">{t("cicdTriggers:config.noProvider")}</option>
								{PROVIDERS.map((p) => (
									<option key={p} value={p}>
										{t(`cicdTriggers:providers.${p}`)}
									</option>
								))}
							</select>

							<div className="flex flex-col gap-2 mt-3">
								<label className="flex items-center gap-2 cursor-pointer">
									<input
										type="checkbox"
										checked={config?.enabled ?? false}
										onChange={(e) =>
											projectPath &&
											setConfig(projectPath, { enabled: e.target.checked })
										}
										className="rounded accent-[var(--accent)]"
									/>
									<span className="text-sm">
										{t("cicdTriggers:config.enabled")}
									</span>
								</label>
								<label className="flex items-center gap-2 cursor-pointer">
									<input
										type="checkbox"
										checked={config?.trigger_on_pr ?? false}
										onChange={(e) =>
											projectPath &&
											setConfig(projectPath, { trigger_on_pr: e.target.checked })
										}
										className="rounded accent-[var(--accent)]"
									/>
									<span className="text-sm">
										{t("cicdTriggers:config.onPr")}
									</span>
								</label>
								<label className="flex items-center gap-2 cursor-pointer">
									<input
										type="checkbox"
										checked={config?.trigger_on_merge ?? false}
										onChange={(e) =>
											projectPath &&
											setConfig(projectPath, {
												trigger_on_merge: e.target.checked,
											})
										}
										className="rounded accent-[var(--accent)]"
									/>
									<span className="text-sm">
										{t("cicdTriggers:config.onMerge")}
									</span>
								</label>
							</div>
						</div>

						<div>
							<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">
								{t("cicdTriggers:trigger.heading")}
							</h3>
							<label
								htmlFor="cicd-branch"
								className="block text-xs text-[var(--text-secondary)] mb-1"
							>
								{t("cicdTriggers:trigger.branch")}
							</label>
							<input
								id="cicd-branch"
								type="text"
								value={branch}
								onChange={(e) => setBranch(e.target.value)}
								placeholder={t("cicdTriggers:trigger.branchPlaceholder")}
								className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-sm mb-2"
							/>
							<label
								htmlFor="cicd-pr-url"
								className="block text-xs text-[var(--text-secondary)] mb-1"
							>
								{t("cicdTriggers:trigger.prUrl")}
							</label>
							<input
								id="cicd-pr-url"
								type="text"
								value={prUrl}
								onChange={(e) => setPrUrl(e.target.value)}
								placeholder={t("cicdTriggers:trigger.prUrlPlaceholder")}
								className="w-full px-2 py-1.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-sm mb-3"
							/>
							<button
								type="button"
								onClick={handleTrigger}
								disabled={!provider || isTriggering}
								className="w-full px-4 py-2 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity text-sm font-medium"
							>
								{isTriggering
									? t("cicdTriggers:actions.triggering")
									: t("cicdTriggers:actions.trigger")}
							</button>
							{!provider && (
								<p className="text-xs text-[var(--text-secondary)] mt-2">
									{t("cicdTriggers:trigger.selectProviderFirst")}
								</p>
							)}
						</div>
					</div>

					{/* Right: runs */}
					<div className="flex-1 flex flex-col overflow-hidden">
						{error && (
							<div className="m-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start justify-between gap-3">
								<span>{error}</span>
								<button
									type="button"
									onClick={clearError}
									className="shrink-0 text-xs underline"
								>
									{t("cicdTriggers:actions.dismiss")}
								</button>
							</div>
						)}

						{runs.length === 0 ? (
							<div className="flex-1 flex items-center justify-center text-center p-8">
								<div>
									<div className="text-5xl mb-4">🚀</div>
									<h3 className="text-lg font-medium mb-2">
										{t("cicdTriggers:empty.title")}
									</h3>
									<p className="text-sm text-[var(--text-secondary)] max-w-sm">
										{t("cicdTriggers:empty.body")}
									</p>
								</div>
							</div>
						) : (
							<div className="flex-1 overflow-auto p-4">
								<h2 className="text-sm font-semibold mb-2">
									{t("cicdTriggers:runs.heading", { count: runs.length })}
								</h2>
								<div className="flex flex-col gap-2">
									{runs.map((run) => (
										<div
											key={run.id}
											className="bg-[var(--bg-secondary)] rounded-lg p-3"
										>
											<div className="flex items-start justify-between gap-2 mb-1">
												<div className="font-medium text-sm">
													{run.branch || t("cicdTriggers:runs.noBranch")}
												</div>
												<span
													className={`text-xs px-1.5 py-0.5 rounded border font-medium shrink-0 ${STATUS_COLORS[run.status] ?? ""}`}
												>
													{t(`cicdTriggers:status.${run.status}`, run.status)}
												</span>
											</div>
											<div className="text-xs text-[var(--text-secondary)]">
												{t(`cicdTriggers:providers.${run.provider}`, {
													defaultValue: run.provider,
												})}
												{" · "}
												{new Date(run.triggered_at).toLocaleString()}
											</div>
											{run.pr_url && (
												<div className="text-xs font-mono opacity-70 mt-1 break-all">
													{run.pr_url}
												</div>
											)}
											{run.error && (
												<div className="text-xs text-red-400 mt-1">
													{run.error}
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export default CICDTriggersDashboard;
