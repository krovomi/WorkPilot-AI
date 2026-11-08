import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
	type ContextMeshTab,
	deleteHandbookEntry,
	deletePattern,
	loadAllContextMeshData,
	registerProject,
	startContextMeshAnalysis,
	stopContextMeshAnalysis,
	unregisterProject,
	updateRecommendationStatus,
	updateSkillTransferStatus,
	useContextMeshStore,
} from "../../stores/context-mesh-store";
import { useProjectStore } from "../../stores/project-store";
import { formatAppDate } from "@/lib/date-format";
import {
	AlertTriangle,
	Info,
	Minus,
	Play,
	Plus,
	Share2,
	Square,
} from "lucide-react";
import {
	CharterButton,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
	Tabs,
} from "../charter";

const TABS: ContextMeshTab[] = [
	"overview",
	"projects",
	"patterns",
	"handbook",
	"transfers",
	"recommendations",
];

/** `errors.analysisRequired` states the contract: the mesh compares projects,
 *  so a single one gives it nothing to compare against. */
const MIN_PROJECTS_FOR_ANALYSIS = 2;

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

export function ContextMeshDashboard(): React.ReactElement {
	const { t } = useTranslation(["contextMesh", "navigation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const {
		phase,
		activeTab,
		status,
		streamingOutput,
		projects,
		patterns,
		handbookEntries,
		skillTransfers,
		recommendations,
		summary,
		error,
		setActiveTab,
	} = useContextMeshStore();

	useEffect(() => {
		loadAllContextMeshData();
	}, []);

	const isAnalyzing = phase === "analyzing";
	const isRegistered = projects.some((p) => p.project_path === projectPath);
	const canAnalyze = projects.length >= MIN_PROJECTS_FOR_ANALYSIS;
	const hasAnalyzed = phase === "complete" || patterns.length > 0;

	function tabCount(tab: ContextMeshTab): number | null {
		switch (tab) {
			case "projects":
				return projects.length;
			case "patterns":
				return patterns.length;
			case "handbook":
				return handbookEntries.length;
			case "transfers":
				return skillTransfers.length;
			case "recommendations":
				return recommendations.length;
			default:
				return null;
		}
	}

	function formatDate(value: string): string {
		if (!value) return t("contextMesh:projects.never");
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime())
			? t("contextMesh:projects.never")
			: formatAppDate(parsed);
	}

	return (
		<ModuleStage data-testid="context-mesh-view">
			<ModuleHeader
				kicker={t("navigation:groups.explore")}
				title={t("contextMesh:title")}
				description={t("contextMesh:description")}
				icon={Share2}
				tone="violet"
				actions={
					<>
						{projectPath && (
							<CharterButton
								size="sm"
								icon={isRegistered ? Minus : Plus}
								onClick={() =>
									isRegistered
										? unregisterProject(projectPath)
										: registerProject(projectPath)
								}
							>
								{isRegistered
									? t("contextMesh:projects.removeProject")
									: t("contextMesh:projects.addProject")}
							</CharterButton>
						)}
						{isAnalyzing ? (
							<CharterButton
								variant="danger"
								icon={Square}
								onClick={() => stopContextMeshAnalysis()}
							>
								{t("contextMesh:actions.stop")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => startContextMeshAnalysis()}
								disabled={!canAnalyze}
							>
								{hasAnalyzed
									? t("contextMesh:actions.reanalyze")
									: t("contextMesh:actions.analyze")}
							</CharterButton>
						)}
					</>
				}
			/>

			<Tabs
				tabs={TABS.map((tab) => {
					const count = tabCount(tab);
					return {
						id: tab,
						label: t(`contextMesh:tabs.${tab}`),
						count: count !== null && count > 0 ? count : undefined,
					};
				})}
				value={activeTab}
				onChange={setActiveTab}
				label={t("contextMesh:title")}
			/>

			{!canAnalyze && !isAnalyzing && (
				<Notice tone="violet" icon={Info} className="relative z-[2] mx-5 mb-3">
					{t("contextMesh:errors.analysisRequired")}
				</Notice>
			)}

			{error && (
				<Notice
					tone="red"
					icon={AlertTriangle}
					role="alert"
					className="relative z-[2] mx-5 mb-3"
				>
					{error}
				</Notice>
			)}

			<div className="relative z-[1] min-h-0 flex-1 overflow-auto px-5 pb-5">
				{/* Overview */}
				{activeTab === "overview" &&
					(summary ? (
						<div className="flex flex-col gap-4">
							<Stats>
								{(
									[
										["projects", summary.project_count],
										["patterns", summary.pattern_count],
										["handbookEntries", summary.handbook_entry_count],
										["skillTransfers", summary.skill_transfer_count],
										["pendingTransfers", summary.pending_transfers],
										["activeRecommendations", summary.active_recommendations],
									] as const
								).map(([key, value]) => (
									<Stat
										key={key}
										label={t(`contextMesh:overview.${key}`)}
										value={value}
									/>
								))}
							</Stats>

							{(isAnalyzing || streamingOutput) && (
								<Panel className="space-y-2">
									{isAnalyzing ? (
										<ScanLine
											label={status || t("contextMesh:status.analyzing")}
										/>
									) : (
										<span className="wp-kicker">
											{status || t("contextMesh:status.complete")}
										</span>
									)}
									<pre className="wp-code max-h-72 overflow-auto whitespace-pre-wrap p-3 text-xs">
										{streamingOutput}
									</pre>
								</Panel>
							)}
						</div>
					) : (
						<div className="flex justify-center py-10">
							<EmptyStage
								icon={Share2}
								title={t("contextMesh:empty.title")}
								tone="violet"
							>
								{t("contextMesh:empty.description")}
							</EmptyStage>
						</div>
					))}

				{/* Projects */}
				{activeTab === "projects" &&
					(projects.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{t("contextMesh:empty.noProjects")}
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<h2 className="text-sm font-semibold">
								{t("contextMesh:projects.title", { count: projects.length })}
							</h2>
							{projects.map((project) => (
								<div
									key={project.project_path}
									className="bg-card rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2">
										<div className="min-w-0">
											<div className="font-medium text-sm">
												{project.project_name}
											</div>
											<div className="text-xs font-mono opacity-70 truncate">
												{project.project_path}
											</div>
										</div>
										<button
											type="button"
											onClick={() => unregisterProject(project.project_path)}
											className="shrink-0 text-xs text-muted-foreground hover:text-destructive underline"
										>
											{t("contextMesh:projects.removeProject")}
										</button>
									</div>
									<div className="text-xs text-muted-foreground mt-1">
										{t("contextMesh:projects.patternCount", {
											count: project.pattern_count,
										})}
										{" · "}
										{t("contextMesh:projects.lastAnalyzed")}:{" "}
										{formatDate(project.last_analyzed_at)}
									</div>
									{project.tech_stack.length > 0 && (
										<div className="text-xs opacity-70 mt-1">
											{t("contextMesh:projects.techStack")}:{" "}
											{project.tech_stack.join(", ")}
										</div>
									)}
									{project.languages.length > 0 && (
										<div className="text-xs opacity-70">
											{t("contextMesh:projects.languages")}:{" "}
											{project.languages.join(", ")}
										</div>
									)}
								</div>
							))}
						</div>
					))}

				{/* Patterns */}
				{activeTab === "patterns" &&
					(patterns.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{t("contextMesh:empty.noPatterns")}
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<h2 className="text-sm font-semibold">
								{t("contextMesh:patterns.title", { count: patterns.length })}
							</h2>
							{patterns.map((pattern) => (
								<div
									key={pattern.pattern_id}
									className="bg-card rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">{pattern.title}</div>
										<div className="flex items-center gap-2 shrink-0">
											<span className="text-xs text-muted-foreground">
												{t("contextMesh:patterns.confidence")}{" "}
												{percent(pattern.confidence)}
											</span>
											<button
												type="button"
												onClick={() => deletePattern(pattern.pattern_id)}
												className="text-xs text-muted-foreground hover:text-destructive underline"
											>
												{t("contextMesh:actions.delete")}
											</button>
										</div>
									</div>
									<div className="text-xs text-muted-foreground mb-1">
										{pattern.description}
									</div>
									<div className="text-xs opacity-70">
										{t(`contextMesh:categories.${pattern.category}`)}
										{" · "}
										{t("contextMesh:patterns.occurrences", {
											count: pattern.occurrence_count,
										})}
										{" · "}
										{t("contextMesh:patterns.adoptionRate", {
											rate: Math.round(pattern.adoption_rate * 100),
										})}
									</div>
									{pattern.source_projects.length > 0 && (
										<div className="text-xs opacity-70 mt-1">
											{t("contextMesh:patterns.sourceProjects")}:{" "}
											{pattern.source_projects.join(", ")}
										</div>
									)}
									{pattern.migration_hint && (
										<div className="text-xs opacity-80 mt-1">
											{t("contextMesh:patterns.migrationHint")}:{" "}
											{pattern.migration_hint}
										</div>
									)}
									{pattern.code_example && (
										<details className="mt-2">
											<summary className="text-xs text-[var(--accent)] cursor-pointer">
												{t("contextMesh:patterns.codeExample")}
											</summary>
											<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-background rounded p-2">
												{pattern.code_example}
											</pre>
										</details>
									)}
								</div>
							))}
						</div>
					))}

				{/* Handbook */}
				{activeTab === "handbook" &&
					(handbookEntries.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{t("contextMesh:empty.noHandbook")}
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<h2 className="text-sm font-semibold">
								{t("contextMesh:handbook.title", {
									count: handbookEntries.length,
								})}
							</h2>
							{handbookEntries.map((entry) => (
								<div
									key={entry.entry_id}
									className="bg-card rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">{entry.title}</div>
										<div className="flex items-center gap-2 shrink-0">
											<span className="text-xs text-muted-foreground">
												{t("contextMesh:handbook.version", {
													version: entry.version,
												})}
											</span>
											<button
												type="button"
												onClick={() => deleteHandbookEntry(entry.entry_id)}
												className="text-xs text-muted-foreground hover:text-destructive underline"
											>
												{t("contextMesh:actions.delete")}
											</button>
										</div>
									</div>
									<div className="text-xs text-muted-foreground mb-1">
										{entry.description}
									</div>
									{entry.decision_rationale && (
										<div className="text-xs opacity-80">
											{t("contextMesh:handbook.rationale")}:{" "}
											{entry.decision_rationale}
										</div>
									)}
									<div className="text-xs opacity-70 mt-1">
										{t("contextMesh:handbook.domain")}:{" "}
										{t(`contextMesh:domains.${entry.domain}`)}
									</div>
									{entry.tags.length > 0 && (
										<div className="text-xs opacity-70">
											{t("contextMesh:handbook.tags")}: {entry.tags.join(", ")}
										</div>
									)}
								</div>
							))}
						</div>
					))}

				{/* Skill transfers */}
				{activeTab === "transfers" &&
					(skillTransfers.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{t("contextMesh:empty.noTransfers")}
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<h2 className="text-sm font-semibold">
								{t("contextMesh:transfers.title", {
									count: skillTransfers.length,
								})}
							</h2>
							{skillTransfers.map((transfer) => (
								<div
									key={transfer.transfer_id}
									className="bg-card rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">
											{transfer.skill_name}
										</div>
										<span className="text-xs text-muted-foreground shrink-0">
											{t("contextMesh:transfers.confidence")}{" "}
											{percent(transfer.confidence)}
										</span>
									</div>
									<div className="text-xs text-muted-foreground mb-1">
										{transfer.description}
									</div>
									<div className="text-xs opacity-70">
										{t("contextMesh:transfers.source")}:{" "}
										{transfer.source_project}
									</div>
									{transfer.target_projects.length > 0 && (
										<div className="text-xs opacity-70">
											{t("contextMesh:transfers.targets")}:{" "}
											{transfer.target_projects.join(", ")}
										</div>
									)}
									{transfer.framework_or_api && (
										<div className="text-xs opacity-70">
											{t("contextMesh:transfers.framework")}:{" "}
											{transfer.framework_or_api}
										</div>
									)}
									<div className="mt-2">
										{transfer.status === "pending" ? (
											<div className="flex items-center gap-2">
												<button
													type="button"
													onClick={() =>
														updateSkillTransferStatus(
															transfer.transfer_id,
															"accepted",
														)
													}
													className="px-3 py-1.5 rounded-lg bg-success/20 text-success hover:bg-success/30 transition-colors text-xs font-medium"
												>
													{t("contextMesh:actions.accept")}
												</button>
												<button
													type="button"
													onClick={() =>
														updateSkillTransferStatus(
															transfer.transfer_id,
															"dismissed",
														)
													}
													className="px-3 py-1.5 rounded-lg bg-background hover:bg-accent transition-colors text-xs"
												>
													{t("contextMesh:actions.dismiss")}
												</button>
											</div>
										) : (
											<span className="text-xs text-muted-foreground">
												{transfer.status === "accepted"
													? t("contextMesh:transfers.statusAccepted")
													: t("contextMesh:transfers.statusDismissed")}
											</span>
										)}
									</div>
								</div>
							))}
						</div>
					))}

				{/* Recommendations */}
				{activeTab === "recommendations" &&
					(recommendations.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							{t("contextMesh:empty.noRecommendations")}
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<h2 className="text-sm font-semibold">
								{t("contextMesh:recommendations.title", {
									count: recommendations.length,
								})}
							</h2>
							{recommendations.map((rec) => (
								<div
									key={rec.recommendation_id}
									className="bg-card rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">{rec.title}</div>
										<span className="text-xs text-muted-foreground shrink-0">
											{t("contextMesh:recommendations.relevance")}{" "}
											{percent(rec.relevance_score)}
										</span>
									</div>
									<div className="text-xs text-muted-foreground mb-1">
										{rec.description}
									</div>
									<div className="text-xs opacity-70">
										{t(
											`contextMesh:recommendations.types.${rec.recommendation_type}`,
										)}
										{rec.source_project &&
											` · ${t("contextMesh:recommendations.source")}: ${rec.source_project}`}
									</div>
									{rec.action_suggestion && (
										<div className="text-xs opacity-80 mt-1">
											{t("contextMesh:recommendations.action")}:{" "}
											{rec.action_suggestion}
										</div>
									)}
									{rec.status === "active" && (
										<div className="flex items-center gap-2 mt-2">
											<button
												type="button"
												onClick={() =>
													updateRecommendationStatus(
														rec.recommendation_id,
														"applied",
													)
												}
												className="px-3 py-1.5 rounded-lg bg-success/20 text-success hover:bg-success/30 transition-colors text-xs font-medium"
											>
												{t("contextMesh:actions.apply")}
											</button>
											<button
												type="button"
												onClick={() =>
													updateRecommendationStatus(
														rec.recommendation_id,
														"dismissed",
													)
												}
												className="px-3 py-1.5 rounded-lg bg-background hover:bg-accent transition-colors text-xs"
											>
												{t("contextMesh:actions.dismiss")}
											</button>
										</div>
									)}
								</div>
							))}
						</div>
					))}
			</div>
		</ModuleStage>
	);
}

export default ContextMeshDashboard;
