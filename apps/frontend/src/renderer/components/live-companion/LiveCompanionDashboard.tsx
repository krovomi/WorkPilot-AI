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
import { Check, Hand, Lightbulb, Play, Radio, Square, X } from "lucide-react";
import {
	CharterButton,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	Stat,
	Stats,
	Chip,
	StepCard,
	type Tone,
} from "../charter";

const PRIORITY_TONE: Record<SuggestionPriority, Tone> = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "blue",
	info: "muted",
};

/** The companion watches files in the main process and pushes nothing to the
 *  renderer, so this view polls for as long as it is running. */
const REFRESH_INTERVAL_MS = 5000;

export function LiveCompanionDashboard(): React.ReactElement {
	const { t } = useTranslation(["liveCompanion", "navigation"]);
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
		<ModuleStage data-testid="live-companion-view">
			<ModuleHeader
				kicker={t("navigation:groups.agents")}
				icon={Radio}
				title={t("liveCompanion:title")}
				description={t("liveCompanion:description")}
				tone="green"
				actions={
					<Chip tone={companionState.active ? "green" : "muted"}>
						{companionState.active ? t("liveCompanion:state.active") : t("liveCompanion:state.inactive")}
					</Chip>
				}
			/>
			<Columns template="minmax(240px, 22%) minmax(280px, 1fr) minmax(320px, 1.3fr)">
				<Column
					kicker={t("liveCompanion:kickers.session")}
					title={t("liveCompanion:sessionTitle")}
					tone="green"
				>
					<div className="flex flex-col gap-3">
						{companionState.active && companionState.watching_project && (
							<p className="wp-meta truncate" title={companionState.watching_project}>
								{t("liveCompanion:state.watching", { project: companionState.watching_project })}
							</p>
						)}
						<Stats>
							<Stat
								label={t("liveCompanion:state.changesDetected", { count: companionState.changes_detected })}
								value={companionState.changes_detected}
								tone="blue"
							/>
							<Stat
								label={t("liveCompanion:state.suggestionsGenerated", {
									count: companionState.suggestions_generated,
								})}
								value={companionState.suggestions_generated}
								tone="amber"
							/>
							<Stat
								label={t("liveCompanion:state.takeoversPending", { count: companionState.takeovers_proposed })}
								value={companionState.takeovers_proposed}
								tone="violet"
							/>
						</Stats>
						{config && (
							<Panel>
								<span className="wp-kicker mb-2 block">{t("liveCompanion:config.title")}</span>
								<label className="mb-2 flex cursor-pointer items-center gap-2">
									<input
										type="checkbox"
										checked={config.suggestion_enabled}
										onChange={(e) => updateCompanionConfig({ suggestion_enabled: e.target.checked })}
										className="rounded accent-[var(--wp-accent)]"
									/>
									<span className="text-sm">{t("liveCompanion:config.suggestions")}</span>
								</label>
								<label className="flex cursor-pointer items-center gap-2">
									<input
										type="checkbox"
										checked={config.takeover_enabled}
										onChange={(e) => updateCompanionConfig({ takeover_enabled: e.target.checked })}
										className="rounded accent-[var(--wp-accent)]"
									/>
									<span className="text-sm">{t("liveCompanion:config.takeover")}</span>
								</label>
							</Panel>
						)}
						{recentChanges.length > 0 && (
							<div>
								<span className="wp-kicker mb-2 block">{t("liveCompanion:fileChange.title")}</span>
								<div className="flex flex-col gap-1">
									{recentChanges.slice(0, 10).map((change) => (
										<div key={`${change.file_path}-${change.timestamp}`} className="text-xs">
											<div className="wp-mono truncate">{change.file_path}</div>
											<div className="wp-faint">{t(`liveCompanion:fileChange.${change.change_type}`)}</div>
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				</Column>

				<Column
					kicker={t("liveCompanion:kickers.takeovers")}
					title={t("liveCompanion:takeover.title")}
					meta={String(takeovers.length)}
					tone="violet"
				>
					{takeovers.length === 0 ? (
						<EmptyStage icon={Hand} title={t("liveCompanion:takeover.emptyTitle")} tone="violet">
							{t("liveCompanion:takeover.emptyHint")}
						</EmptyStage>
					) : (
						<div className="flex flex-col gap-3">
							{takeovers.map((proposal) => (
								<StepCard
									key={proposal.proposal_id}
									tone="violet"
									kicker={t("liveCompanion:takeover.proposal")}
									title={<span className="wp-mono text-[0.8rem]">{proposal.file_path}</span>}
									meta={`${t("liveCompanion:takeover.reason")}: ${proposal.reason}`}
								>
									<span className="wp-muted mt-1 text-xs whitespace-normal">{proposal.description}</span>
									{proposal.ai_plan && (
										<details className="mt-2">
											<summary className="cursor-pointer text-xs text-primary">
												{t("liveCompanion:actions.viewDetails")}
											</summary>
											<pre className="wp-code mt-1 whitespace-pre-wrap p-2 text-xs">{proposal.ai_plan}</pre>
										</details>
									)}
									<span className="mt-2 flex items-center gap-2">
										<CharterButton size="sm" icon={Check} onClick={() => acceptTakeover(proposal.proposal_id)}>
											{t("liveCompanion:takeover.accept")}
										</CharterButton>
										<CharterButton
											size="sm"
											variant="ghost"
											icon={X}
											onClick={() => declineTakeover(proposal.proposal_id)}
										>
											{t("liveCompanion:takeover.decline")}
										</CharterButton>
									</span>
								</StepCard>
							))}
						</div>
					)}
				</Column>

				<Column
					kicker={t("liveCompanion:kickers.suggestions")}
					title={t("liveCompanion:suggestions.title")}
					meta={String(suggestions.length)}
					tone="amber"
				>
					{suggestions.length === 0 ? (
						<EmptyStage icon={Lightbulb} title={t("liveCompanion:suggestions.emptyTitle")} tone="amber">
							{t("liveCompanion:suggestions.empty")}
						</EmptyStage>
					) : (
						<div className="flex flex-col gap-3">
							{suggestions.map((suggestion) => (
								<StepCard
									key={suggestion.suggestion_id}
									tone={PRIORITY_TONE[suggestion.priority] ?? "muted"}
									kicker={`${t(`liveCompanion:suggestions.priorities.${suggestion.priority}`)} · ${t(
										`liveCompanion:suggestions.types.${suggestion.suggestion_type}`,
									)}`}
									title={suggestion.title}
									meta={`${suggestion.file_path}${suggestion.line_start ? `:${suggestion.line_start}` : ""}`}
									status={
										<span className="wp-meta">
											{t("liveCompanion:suggestions.confidence", {
												value: Math.round(suggestion.confidence * 100),
											})}
										</span>
									}
								>
									<span className="wp-muted mt-1 text-xs whitespace-normal">{suggestion.description}</span>
									{suggestion.related_files.length > 0 && (
										<span className="wp-meta mt-1 whitespace-normal">
											{t("liveCompanion:suggestions.relatedFiles")}: {suggestion.related_files.join(", ")}
										</span>
									)}
									{suggestion.code_fix && (
										<details className="mt-2">
											<summary className="cursor-pointer text-xs text-primary">
												{t("liveCompanion:suggestions.codeFix")}
											</summary>
											<pre className="wp-code mt-1 whitespace-pre-wrap p-2 text-xs">{suggestion.code_fix}</pre>
										</details>
									)}
									<span className="mt-2 flex items-center gap-2">
										<CharterButton size="sm" icon={Check} onClick={() => applySuggestion(suggestion.suggestion_id)}>
											{t("liveCompanion:actions.apply")}
										</CharterButton>
										<CharterButton
											size="sm"
											variant="ghost"
											icon={X}
											onClick={() => dismissSuggestion(suggestion.suggestion_id)}
										>
											{t("liveCompanion:actions.dismiss")}
										</CharterButton>
									</span>
								</StepCard>
							))}
						</div>
					)}
				</Column>
			</Columns>
			{!projectPath && !companionState.active && (
				<Notice tone="amber" className="relative z-[2] mx-5 mb-2">
					{t("liveCompanion:errors.noProject")}
				</Notice>
			)}
			<Composer
				prompt={
					<span className="wp-muted flex min-w-0 items-center gap-2 text-xs">
						<Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						<span className="truncate">{t("liveCompanion:description")}</span>
					</span>
				}
				actions={
					<CharterButton
						variant={companionState.active ? "danger" : "primary"}
						icon={companionState.active ? Square : Play}
						busy={isLoading}
						onClick={handleToggle}
						disabled={isLoading || (!companionState.active && !projectPath)}
					>
						{companionState.active ? t("liveCompanion:actions.stop") : t("liveCompanion:actions.start")}
					</CharterButton>
				}
			/>
		</ModuleStage>
	);
}

export default LiveCompanionDashboard;
