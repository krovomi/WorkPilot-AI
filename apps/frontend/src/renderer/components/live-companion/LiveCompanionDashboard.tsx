import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	LiveSuggestion,
	SuggestionPriority,
	TakeoverProposal,
} from "../../../shared/types/live-companion";
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
import { createTask } from "../../stores/task-store";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, Hand, KanbanSquare, Lightbulb, Play, Radio, Square, X } from "lucide-react";
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
import { formatPause, suggestionTask, takeoverTask } from "./companion-tasks";

const PRIORITY_TONE: Record<SuggestionPriority, Tone> = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "blue",
	info: "muted",
};

function samePath(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const normalize = (p: string) => p.replace(/[\\/]+$/, "").replaceAll("\\", "/");
	return normalize(a) === normalize(b);
}

export function LiveCompanionDashboard(): React.ReactElement {
	const { t } = useTranslation(["liveCompanion", "navigation", "common"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const activeProjectId = activeProject?.id;
	const { companionState, config, suggestions, takeovers, recentChanges, isLoading, error } =
		useLiveCompanionStore(
			useShallow((s) => ({
				companionState: s.companionState,
				config: s.config,
				suggestions: s.suggestions,
				takeovers: s.takeovers,
				recentChanges: s.recentChanges,
				isLoading: s.isLoading,
				error: s.error,
			})),
		);
	const [taskNotice, setTaskNotice] = useState<"created" | "failed" | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	// Main pushes the state, each suggestion and each proposal
	// (global-listeners.ts); the page only loads what was stored, per project.
	const refresh = useCallback(() => {
		loadCompanionState();
		loadSuggestions(projectPath);
		loadTakeovers(projectPath);
	}, [projectPath]);

	useEffect(() => {
		loadCompanionConfig();
		refresh();
	}, [refresh]);

	const watchingOther =
		companionState.active &&
		!!projectPath &&
		!samePath(companionState.watching_project, projectPath);
	const lastError = companionState.last_error;

	async function handleToggle() {
		if (companionState.active) {
			await stopCompanion();
		} else if (projectPath) {
			await startCompanion(projectPath);
		}
		refresh();
	}

	async function handleWatchThis() {
		if (!projectPath) return;
		await startCompanion(projectPath);
		refresh();
	}

	async function toTask(
		id: string,
		task: { title: string; description: string },
		markDone: () => Promise<boolean>,
	) {
		if (!activeProjectId) return;
		setBusyId(id);
		try {
			const created = await createTask(activeProjectId, task.title, task.description);
			if (created) await markDone();
			setTaskNotice(created ? "created" : "failed");
		} finally {
			setBusyId(null);
		}
	}

	const suggestionToTask = (suggestion: LiveSuggestion) =>
		toTask(suggestion.suggestion_id, suggestionTask(t, suggestion), () =>
			applySuggestion(suggestion.suggestion_id),
		);
	const takeoverToTask = (proposal: TakeoverProposal) =>
		toTask(proposal.proposal_id, takeoverTask(t, proposal), () =>
			acceptTakeover(proposal.proposal_id),
		);

	return (
		<ModuleStage data-testid="live-companion-view">
			<ModuleHeader
				kicker={t("navigation:groups.agents")}
				icon={Radio}
				title={t("liveCompanion:title")}
				description={t("liveCompanion:description")}
				tone="green"
				actions={
					<Chip tone={companionState.analyzing ? "amber" : companionState.active ? "green" : "muted"}>
						{companionState.analyzing
							? t("liveCompanion:state.analyzing")
							: companionState.active
								? t("liveCompanion:state.active")
								: t("liveCompanion:state.inactive")}
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
								label={t("liveCompanion:state.changesDetected")}
								value={companionState.changes_detected}
								tone="blue"
							/>
							<Stat
								label={t("liveCompanion:state.suggestionsGenerated")}
								value={suggestions.length}
								tone="amber"
							/>
							<Stat
								label={t("liveCompanion:state.takeoversPending")}
								value={takeovers.length}
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
									meta={t(`liveCompanion:takeover.reasons.${proposal.reason}`, {
										defaultValue: proposal.reason,
									})}
								>
									<span className="wp-muted mt-1 text-xs whitespace-normal">
										{t("liveCompanion:takeover.description", {
											duration: formatPause(t, proposal.inactivity_seconds),
											count: proposal.change_count ?? 0,
										})}
									</span>
									{proposal.ai_plan && (
										<details className="mt-2">
											<summary className="cursor-pointer text-xs text-primary">
												{t("liveCompanion:actions.viewDetails")}
											</summary>
											<pre className="wp-code mt-1 whitespace-pre-wrap p-2 text-xs">{proposal.ai_plan}</pre>
										</details>
									)}
									<span className="mt-2 flex items-center gap-2">
										<CharterButton
											size="sm"
											icon={KanbanSquare}
											busy={busyId === proposal.proposal_id}
											disabled={!activeProjectId || busyId !== null}
											onClick={() => takeoverToTask(proposal)}
										>
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
							{companionState.active && !watchingOther
								? t("liveCompanion:suggestions.emptyActive")
								: t("liveCompanion:suggestions.empty")}
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
										<CharterButton
											size="sm"
											icon={KanbanSquare}
											busy={busyId === suggestion.suggestion_id}
											disabled={!activeProjectId || busyId !== null}
											onClick={() => suggestionToTask(suggestion)}
										>
											{t("liveCompanion:actions.createTask")}
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
			{watchingOther && (
				<Notice tone="amber" className="relative z-[2] mx-5 mb-2">
					<span className="flex flex-wrap items-center gap-2">
						<span>
							{t("liveCompanion:state.watchingOther", { project: companionState.watching_project })}
						</span>
						<CharterButton size="sm" variant="ghost" icon={Play} onClick={handleWatchThis}>
							{t("liveCompanion:actions.watchThis")}
						</CharterButton>
					</span>
				</Notice>
			)}
			{error && !companionState.active && (
				<Notice tone="red" role="alert" icon={AlertTriangle} className="relative z-[2] mx-5 mb-2">
					{t("liveCompanion:errors.startFailed", { message: error })}
				</Notice>
			)}
			{lastError && (
				<Notice tone="red" role="alert" icon={AlertTriangle} className="relative z-[2] mx-5 mb-2">
					<span className="block">
						{lastError.file_path
							? t("liveCompanion:errors.analysisFailedFile", {
									file: lastError.file_path,
									message: lastError.message,
								})
							: t("liveCompanion:errors.analysisFailed", { message: lastError.message })}
					</span>
					<span className="wp-meta block">
						{t("liveCompanion:errors.code", { code: lastError.code })}
						{lastError.provider ? ` · ${lastError.provider}` : ""}
						{lastError.model ? ` · ${lastError.model}` : ""}
					</span>
					<span className="wp-muted block text-xs">{t("liveCompanion:errors.providerHint")}</span>
				</Notice>
			)}
			{taskNotice && (
				<Notice
					tone={taskNotice === "created" ? "green" : "red"}
					role="status"
					className="relative z-[2] mx-5 mb-2"
				>
					<span className="flex items-center gap-2">
						<span className="flex-1">
							{taskNotice === "created" ? t("liveCompanion:task.created") : t("liveCompanion:task.failed")}
						</span>
						<button
							type="button"
							className="wp-muted"
							aria-label={t("common:buttons.close")}
							onClick={() => setTaskNotice(null)}
						>
							<X className="h-3.5 w-3.5" aria-hidden="true" />
						</button>
					</span>
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
