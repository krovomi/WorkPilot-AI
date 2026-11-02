import type React from "react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { SuggestionPriority } from "../../../shared/types/live-companion";
import {
	acceptTakeover,
	applySuggestion,
	declineTakeover,
	dismissSuggestion,
	loadCompanionConfig,
	loadCompanionState,
	loadSuggestions,
	loadTakeovers,
	startCompanion,
	stopCompanion,
	updateCompanionConfig,
	useLiveCompanionStore,
} from "../../stores/live-companion-store";
import { useProjectStore } from "../../stores/project-store";
import { Radio } from "lucide-react";
import { PageHeader } from "../ui/page-header";

const PRIORITY_COLORS: Record<SuggestionPriority, string> = {
	critical: "text-red-400 bg-red-500/10 border-red-500/20",
	high: "text-orange-400 bg-orange-500/10 border-orange-500/20",
	medium: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
	low: "text-blue-400 bg-blue-500/10 border-blue-500/20",
	info: "text-muted-foreground bg-card border-border",
};

/** The companion watches files in the main process and pushes nothing to the
 *  renderer, so this view polls for as long as it is running. */
const REFRESH_INTERVAL_MS = 5000;

export function LiveCompanionDashboard(): React.ReactElement {
	const { t } = useTranslation(["liveCompanion"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const {
		companionState,
		config,
		suggestions,
		takeovers,
		recentChanges,
		isLoading,
	} = useLiveCompanionStore();

	const refresh = useCallback(() => {
		loadCompanionState();
		loadSuggestions();
		loadTakeovers();
	}, []);

	useEffect(() => {
		loadCompanionConfig();
		refresh();
	}, [refresh]);

	useEffect(() => {
		if (!companionState.active) return;
		const id = setInterval(refresh, REFRESH_INTERVAL_MS);
		return () => clearInterval(id);
	}, [companionState.active, refresh]);

	async function handleToggle() {
		if (companionState.active) {
			await stopCompanion();
		} else if (projectPath) {
			await startCompanion(projectPath);
		}
		refresh();
	}

	return (
		<div className="flex flex-col h-full bg-background text-foreground">
			<PageHeader
				icon={Radio}
				title={t("liveCompanion:title")}
				description={t("liveCompanion:description")}
				actions={
					<>
						<span
							className={`text-xs px-2 py-1 rounded border font-medium ${
								companionState.active
									? "text-green-400 bg-green-500/10 border-green-500/20"
									: "text-muted-foreground bg-card border-border"
							}`}
						>
							{companionState.active
								? t("liveCompanion:state.active")
								: t("liveCompanion:state.inactive")}
						</span>
						<button
							type="button"
							onClick={handleToggle}
							disabled={isLoading || (!companionState.active && !projectPath)}
							className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
								companionState.active
									? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
									: "bg-[var(--accent)] text-white hover:opacity-90"
							}`}
						>
							{companionState.active
								? t("liveCompanion:actions.stop")
								: t("liveCompanion:actions.start")}
						</button>
					</>
				}
			>
				{!projectPath && !companionState.active && (
					<p className="text-xs text-muted-foreground">
						{t("liveCompanion:errors.noProject")}
					</p>
				)}
			</PageHeader>

			<div className="flex flex-1 overflow-hidden">
				{/* Left: session, options, recent changes */}
				<div className="w-64 border-r border-border p-4 flex flex-col gap-5 overflow-auto">
					{companionState.active && companionState.watching_project && (
						<div className="text-xs text-muted-foreground">
							{t("liveCompanion:state.watching", {
								project: companionState.watching_project,
							})}
						</div>
					)}

					<div className="flex flex-col gap-2">
						<div className="bg-card rounded-lg p-2.5">
							<div className="text-lg font-bold">
								{companionState.changes_detected}
							</div>
							<div className="text-xs text-muted-foreground">
								{t("liveCompanion:state.changesDetected", {
									count: companionState.changes_detected,
								})}
							</div>
						</div>
						<div className="bg-card rounded-lg p-2.5">
							<div className="text-lg font-bold">
								{companionState.suggestions_generated}
							</div>
							<div className="text-xs text-muted-foreground">
								{t("liveCompanion:state.suggestionsGenerated", {
									count: companionState.suggestions_generated,
								})}
							</div>
						</div>
						<div className="bg-card rounded-lg p-2.5">
							<div className="text-lg font-bold">
								{companionState.takeovers_proposed}
							</div>
							<div className="text-xs text-muted-foreground">
								{t("liveCompanion:state.takeoversPending", {
									count: companionState.takeovers_proposed,
								})}
							</div>
						</div>
					</div>

					{config && (
						<div>
							<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
								{t("liveCompanion:config.title")}
							</h3>
							<label className="flex items-center gap-2 cursor-pointer mb-2">
								<input
									type="checkbox"
									checked={config.suggestion_enabled}
									onChange={(e) =>
										updateCompanionConfig({
											suggestion_enabled: e.target.checked,
										})
									}
									className="rounded accent-[var(--accent)]"
								/>
								<span className="text-sm">
									{t("liveCompanion:config.suggestions")}
								</span>
							</label>
							<label className="flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									checked={config.takeover_enabled}
									onChange={(e) =>
										updateCompanionConfig({ takeover_enabled: e.target.checked })
									}
									className="rounded accent-[var(--accent)]"
								/>
								<span className="text-sm">
									{t("liveCompanion:config.takeover")}
								</span>
							</label>
						</div>
					)}

					{recentChanges.length > 0 && (
						<div>
							<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
								{t("liveCompanion:fileChange.title")}
							</h3>
							<div className="flex flex-col gap-1">
								{recentChanges.slice(0, 10).map((change) => (
									<div
										key={`${change.file_path}-${change.timestamp}`}
										className="text-xs"
									>
										<div className="font-mono truncate">{change.file_path}</div>
										<div className="text-muted-foreground">
											{t(`liveCompanion:fileChange.${change.change_type}`)}
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</div>

				{/* Right: takeovers + suggestions */}
				<div className="flex-1 overflow-auto p-4 flex flex-col gap-5">
					{takeovers.length > 0 && (
						<section>
							<h2 className="text-sm font-semibold mb-2">
								{t("liveCompanion:takeover.title")}
							</h2>
							<div className="flex flex-col gap-2">
								{takeovers.map((proposal) => (
									<div
										key={proposal.proposal_id}
										className="rounded-lg p-3 border border-[var(--accent)]/30 bg-[var(--accent)]/5"
									>
										<div className="font-medium text-sm mb-1">
											{t("liveCompanion:takeover.proposal")}
										</div>
										<div className="text-xs font-mono opacity-70 mb-1">
											{proposal.file_path}
										</div>
										<div className="text-xs text-muted-foreground mb-1">
											{t("liveCompanion:takeover.reason")}: {proposal.reason}
										</div>
										<div className="text-xs text-muted-foreground mb-2">
											{proposal.description}
										</div>
										{proposal.ai_plan && (
											<details className="mb-2">
												<summary className="text-xs text-[var(--accent)] cursor-pointer">
													{t("liveCompanion:actions.viewDetails")}
												</summary>
												<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-card rounded p-2">
													{proposal.ai_plan}
												</pre>
											</details>
										)}
										<div className="flex items-center gap-2">
											<button
												type="button"
												onClick={() => acceptTakeover(proposal.proposal_id)}
												className="px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors text-xs font-medium"
											>
												{t("liveCompanion:takeover.accept")}
											</button>
											<button
												type="button"
												onClick={() => declineTakeover(proposal.proposal_id)}
												className="px-3 py-1.5 rounded-lg bg-card hover:bg-accent transition-colors text-xs"
											>
												{t("liveCompanion:takeover.decline")}
											</button>
										</div>
									</div>
								))}
							</div>
						</section>
					)}

					<section className="flex-1">
						<h2 className="text-sm font-semibold mb-2">
							{t("liveCompanion:suggestions.title")}
						</h2>
						{suggestions.length === 0 ? (
							<div className="flex-1 flex items-center justify-center text-center py-12">
								<p className="text-sm text-muted-foreground max-w-sm">
									{t("liveCompanion:suggestions.empty")}
								</p>
							</div>
						) : (
							<div className="flex flex-col gap-2">
								{suggestions.map((suggestion) => (
									<div
										key={suggestion.suggestion_id}
										className={`rounded-lg p-3 border ${PRIORITY_COLORS[suggestion.priority] ?? ""}`}
									>
										<div className="flex items-start justify-between gap-2 mb-1">
											<div className="font-medium text-sm">
												{suggestion.title}
											</div>
											<div className="flex items-center gap-2 shrink-0 text-xs">
												<span>
													{t(
														`liveCompanion:suggestions.types.${suggestion.suggestion_type}`,
													)}
												</span>
												<span className="px-1.5 py-0.5 rounded font-medium">
													{t(
														`liveCompanion:suggestions.priorities.${suggestion.priority}`,
													)}
												</span>
											</div>
										</div>
										<div className="text-xs font-mono opacity-70 mb-1">
											{suggestion.file_path}
											{suggestion.line_start ? `:${suggestion.line_start}` : ""}
										</div>
										<div className="text-xs opacity-80 mb-1">
											{suggestion.description}
										</div>
										<div className="text-xs opacity-70 mb-2">
											{t("liveCompanion:suggestions.confidence", {
												value: Math.round(suggestion.confidence * 100),
											})}
										</div>
										{suggestion.related_files.length > 0 && (
											<div className="text-xs opacity-70 mb-2">
												{t("liveCompanion:suggestions.relatedFiles")}:{" "}
												{suggestion.related_files.join(", ")}
											</div>
										)}
										{suggestion.code_fix && (
											<details className="mb-2">
												<summary className="text-xs cursor-pointer underline">
													{t("liveCompanion:suggestions.codeFix")}
												</summary>
												<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-background rounded p-2">
													{suggestion.code_fix}
												</pre>
											</details>
										)}
										<div className="flex items-center gap-2">
											<button
												type="button"
												onClick={() => applySuggestion(suggestion.suggestion_id)}
												className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 transition-opacity text-xs font-medium"
											>
												{t("liveCompanion:actions.apply")}
											</button>
											<button
												type="button"
												onClick={() =>
													dismissSuggestion(suggestion.suggestion_id)
												}
												className="px-3 py-1.5 rounded-lg bg-card hover:bg-accent transition-colors text-xs"
											>
												{t("liveCompanion:actions.dismiss")}
											</button>
										</div>
									</div>
								))}
							</div>
						)}
					</section>
				</div>
			</div>
		</div>
	);
}

export default LiveCompanionDashboard;
