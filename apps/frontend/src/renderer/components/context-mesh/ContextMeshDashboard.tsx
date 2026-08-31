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
	const { t } = useTranslation(["contextMesh"]);
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
			: parsed.toLocaleDateString();
	}

	return (
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			{/* Header */}
			<div className="px-6 py-4 border-b border-[var(--border-color)]">
				<div className="flex items-center justify-between gap-6">
					<div>
						<h1 className="text-xl font-semibold">{t("contextMesh:title")}</h1>
						<p className="text-sm text-[var(--text-secondary)] mt-0.5 max-w-3xl">
							{t("contextMesh:description")}
						</p>
					</div>
					<div className="flex items-center gap-3 shrink-0">
						{projectPath && (
							<button
								type="button"
								onClick={() =>
									isRegistered
										? unregisterProject(projectPath)
										: registerProject(projectPath)
								}
								className="px-3 py-2 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] transition-colors text-sm"
							>
								{isRegistered
									? t("contextMesh:projects.removeProject")
									: t("contextMesh:projects.addProject")}
							</button>
						)}
						{isAnalyzing ? (
							<button
								type="button"
								onClick={() => stopContextMeshAnalysis()}
								className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors text-sm font-medium"
							>
								{t("contextMesh:actions.stop")}
							</button>
						) : (
							<button
								type="button"
								onClick={() => startContextMeshAnalysis()}
								disabled={!canAnalyze}
								className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity text-sm font-medium"
							>
								{hasAnalyzed
									? t("contextMesh:actions.reanalyze")
									: t("contextMesh:actions.analyze")}
							</button>
						)}
					</div>
				</div>
				{!canAnalyze && !isAnalyzing && (
					<p className="text-xs text-[var(--text-secondary)] mt-2">
						{t("contextMesh:errors.analysisRequired")}
					</p>
				)}
			</div>

			{/* Tabs */}
			<div className="px-6 border-b border-[var(--border-color)] flex items-center gap-1 overflow-x-auto">
				{TABS.map((tab) => {
					const count = tabCount(tab);
					return (
						<button
							key={tab}
							type="button"
							onClick={() => setActiveTab(tab)}
							className={`px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
								activeTab === tab
									? "border-[var(--accent)] text-[var(--text-primary)] font-medium"
									: "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
							}`}
						>
							{t(`contextMesh:tabs.${tab}`)}
							{count !== null && count > 0 && (
								<span className="ml-1.5 text-xs opacity-60">{count}</span>
							)}
						</button>
					);
				})}
			</div>

			{error && (
				<div className="m-4 mb-0 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
					{error}
				</div>
			)}

			<div className="flex-1 overflow-auto p-4">
				{/* Overview */}
				{activeTab === "overview" &&
					(summary ? (
						<div className="flex flex-col gap-4">
							<div className="grid grid-cols-3 gap-3">
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
									<div
										key={key}
										className="bg-[var(--bg-secondary)] rounded-lg p-3"
									>
										<div className="text-2xl font-bold">{value}</div>
										<div className="text-xs text-[var(--text-secondary)]">
											{t(`contextMesh:overview.${key}`)}
										</div>
									</div>
								))}
							</div>

							{(isAnalyzing || streamingOutput) && (
								<div>
									<h2 className="text-sm font-semibold mb-2">
										{status ||
											t(
												isAnalyzing
													? "contextMesh:status.analyzing"
													: "contextMesh:status.complete",
											)}
									</h2>
									<pre className="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap bg-[var(--bg-secondary)] rounded-lg p-3">
										{streamingOutput}
									</pre>
								</div>
							)}
						</div>
					) : (
						<div className="text-center py-12">
							<div className="text-5xl mb-4">🕸️</div>
							<h3 className="text-lg font-medium mb-2">
								{t("contextMesh:empty.title")}
							</h3>
							<p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
								{t("contextMesh:empty.description")}
							</p>
						</div>
					))}

				{/* Projects */}
				{activeTab === "projects" &&
					(projects.length === 0 ? (
						<p className="text-sm text-[var(--text-secondary)]">
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
									className="bg-[var(--bg-secondary)] rounded-lg p-3"
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
											className="shrink-0 text-xs text-[var(--text-secondary)] hover:text-red-400 underline"
										>
											{t("contextMesh:projects.removeProject")}
										</button>
									</div>
									<div className="text-xs text-[var(--text-secondary)] mt-1">
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
						<p className="text-sm text-[var(--text-secondary)]">
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
									className="bg-[var(--bg-secondary)] rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">{pattern.title}</div>
										<div className="flex items-center gap-2 shrink-0">
											<span className="text-xs text-[var(--text-secondary)]">
												{t("contextMesh:patterns.confidence")}{" "}
												{percent(pattern.confidence)}
											</span>
											<button
												type="button"
												onClick={() => deletePattern(pattern.pattern_id)}
												className="text-xs text-[var(--text-secondary)] hover:text-red-400 underline"
											>
												{t("contextMesh:actions.delete")}
											</button>
										</div>
									</div>
									<div className="text-xs text-[var(--text-secondary)] mb-1">
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
											<pre className="mt-1 text-xs font-mono whitespace-pre-wrap bg-[var(--bg-primary)] rounded p-2">
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
						<p className="text-sm text-[var(--text-secondary)]">
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
									className="bg-[var(--bg-secondary)] rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">{entry.title}</div>
										<div className="flex items-center gap-2 shrink-0">
											<span className="text-xs text-[var(--text-secondary)]">
												{t("contextMesh:handbook.version", {
													version: entry.version,
												})}
											</span>
											<button
												type="button"
												onClick={() => deleteHandbookEntry(entry.entry_id)}
												className="text-xs text-[var(--text-secondary)] hover:text-red-400 underline"
											>
												{t("contextMesh:actions.delete")}
											</button>
										</div>
									</div>
									<div className="text-xs text-[var(--text-secondary)] mb-1">
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
						<p className="text-sm text-[var(--text-secondary)]">
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
									className="bg-[var(--bg-secondary)] rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">
											{transfer.skill_name}
										</div>
										<span className="text-xs text-[var(--text-secondary)] shrink-0">
											{t("contextMesh:transfers.confidence")}{" "}
											{percent(transfer.confidence)}
										</span>
									</div>
									<div className="text-xs text-[var(--text-secondary)] mb-1">
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
													className="px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors text-xs font-medium"
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
													className="px-3 py-1.5 rounded-lg bg-[var(--bg-primary)] hover:bg-[var(--bg-hover)] transition-colors text-xs"
												>
													{t("contextMesh:actions.dismiss")}
												</button>
											</div>
										) : (
											<span className="text-xs text-[var(--text-secondary)]">
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
						<p className="text-sm text-[var(--text-secondary)]">
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
									className="bg-[var(--bg-secondary)] rounded-lg p-3"
								>
									<div className="flex items-start justify-between gap-2 mb-1">
										<div className="font-medium text-sm">{rec.title}</div>
										<span className="text-xs text-[var(--text-secondary)] shrink-0">
											{t("contextMesh:recommendations.relevance")}{" "}
											{percent(rec.relevance_score)}
										</span>
									</div>
									<div className="text-xs text-[var(--text-secondary)] mb-1">
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
												className="px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors text-xs font-medium"
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
												className="px-3 py-1.5 rounded-lg bg-[var(--bg-primary)] hover:bg-[var(--bg-hover)] transition-colors text-xs"
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
		</div>
	);
}

export default ContextMeshDashboard;
