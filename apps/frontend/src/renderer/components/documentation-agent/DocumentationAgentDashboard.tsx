import type React from "react";
import { useTranslation } from "react-i18next";
import {
	AVAILABLE_DOC_TYPES,
	cancelDocumentation,
	type DocTypeKey,
	type DocumentationAgentPhase,
	generateDocumentation,
	useDocumentationAgentStore,
} from "../../stores/documentation-agent-store";
import { useProjectStore } from "../../stores/project-store";

// Les libellés sont des clés, pas du texte : la phase et le type de document
// sont affichés à l'utilisateur, et cette page était la seule du menu à les
// écrire en dur — le libellé de la barre latérale, lui, était déjà traduit.
const PHASE_LABEL_KEYS: Record<DocumentationAgentPhase, string> = {
	idle: "documentation:agent.phase.idle",
	analyzing: "documentation:agent.phase.analyzing",
	generating: "documentation:agent.phase.generating",
	updating: "documentation:agent.phase.updating",
	complete: "documentation:agent.phase.complete",
	error: "documentation:agent.phase.error",
};

const DOC_TYPE_LABEL_KEYS: Record<DocTypeKey, string> = {
	readme: "documentation:agent.docType.readme",
	api: "documentation:agent.docType.api",
	contribution: "documentation:agent.docType.contribution",
	docstrings: "documentation:agent.docType.docstrings",
	diagrams: "documentation:agent.docType.diagrams",
};

const DOC_TYPE_ICONS: Record<DocTypeKey, string> = {
	readme: "📄",
	api: "🔌",
	contribution: "🤝",
	docstrings: "💬",
	diagrams: "📊",
};

export function DocumentationAgentDashboard(): React.ReactElement {
	const { t } = useTranslation(["documentation", "common"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const {
		phase,
		status,
		streamingOutput,
		result,
		error,
		selectedDocTypes,
		insertInline,
		outputDir,
		toggleDocType,
		setInsertInline,
		setOutputDir,
	} = useDocumentationAgentStore();

	const isRunning = ["analyzing", "generating", "updating"].includes(phase);
	const isComplete = phase === "complete";

	function handleStart() {
		if (!activeProject?.path || selectedDocTypes.length === 0) return;
		generateDocumentation(activeProject.path);
	}

	return (
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			{/* Header */}
			<div className="px-6 py-4 border-b border-[var(--border-color)]">
				<h1 className="text-xl font-semibold">{t("documentation:title")}</h1>
				<p className="text-sm text-[var(--text-secondary)] mt-0.5">
					{t("documentation:agent.subtitle")}
				</p>
			</div>

			<div className="flex flex-1 overflow-hidden">
				{/* Left: Config panel */}
				<div className="w-64 border-r border-[var(--border-color)] p-4 flex flex-col gap-4 overflow-y-auto">
					{/* Doc types */}
					<div>
						<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
							{t("documentation:agent.docTypes")}
						</h3>
						<div className="flex flex-col gap-1">
							{AVAILABLE_DOC_TYPES.map((type) => (
								<label
									key={type}
									className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--bg-secondary)] cursor-pointer"
								>
									<input
										type="checkbox"
										checked={selectedDocTypes.includes(type)}
										onChange={() => toggleDocType(type)}
										disabled={isRunning}
										className="rounded accent-[var(--accent)]"
									/>
									<span className="text-sm">
										{DOC_TYPE_ICONS[type]} {t(DOC_TYPE_LABEL_KEYS[type])}
									</span>
								</label>
							))}
						</div>
					</div>

					{/* Options */}
					<div>
						<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
							{t("documentation:agent.options")}
						</h3>
						<label className="flex items-center gap-2 cursor-pointer mb-3">
							<input
								type="checkbox"
								checked={insertInline}
								onChange={(e) => setInsertInline(e.target.checked)}
								disabled={isRunning}
								className="rounded accent-[var(--accent)]"
							/>
							<div>
								<div className="text-sm font-medium">
									{t("documentation:agent.insertInline")}
								</div>
								<div className="text-xs text-[var(--text-secondary)]">
									{t("documentation:agent.insertInlineHint")}
								</div>
							</div>
						</label>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
						<label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
							{t("documentation:agent.outputDir")}
						</label>
						<input
							type="text"
							value={outputDir}
							onChange={(e) => setOutputDir(e.target.value)}
							disabled={isRunning}
							placeholder="docs/"
							className="w-full rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:opacity-50"
						/>
					</div>

					{/* Actions */}
					<div className="mt-auto flex flex-col gap-2">
						{isRunning ? (
							<button
								type="button"
								onClick={cancelDocumentation}
								className="w-full px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors text-sm font-medium"
							>
								{t("common:cancel", "Cancel")}
							</button>
						) : (
							<button
								type="button"
								onClick={handleStart}
								disabled={!activeProject || selectedDocTypes.length === 0}
								className="w-full px-4 py-2 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity text-sm font-medium"
							>
								{isComplete
									? t("documentation:agent.regenerate")
									: t("documentation:agent.generate")}
							</button>
						)}
					</div>
				</div>

				{/* Right: Output panel */}
				<div className="flex-1 flex flex-col overflow-hidden">
					{/* Phase indicator */}
					{phase !== "idle" && (
						<div className="px-4 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex items-center gap-2 text-sm text-[var(--text-secondary)]">
							{isRunning && (
								// biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative
								<svg
									className="animate-spin w-4 h-4 text-[var(--accent)] shrink-0"
									fill="none"
									viewBox="0 0 24 24"
								>
									<circle
										className="opacity-25"
										cx="12"
										cy="12"
										r="10"
										stroke="currentColor"
										strokeWidth="4"
									/>
									<path
										className="opacity-75"
										fill="currentColor"
										d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
									/>
								</svg>
							)}
							<span>{t(PHASE_LABEL_KEYS[phase])}</span>
							{status && status !== t(PHASE_LABEL_KEYS[phase]) && (
								<span className="ml-1">— {status}</span>
							)}
						</div>
					)}

					{/* Error */}
					{error && (
						<div className="m-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
							{error}
						</div>
					)}

					{/* Results */}
					{isComplete && result && (
						<div className="p-4 border-b border-[var(--border-color)]">
							<div className="flex items-center gap-3 mb-3">
								<span className="text-2xl">📚</span>
								<div>
									<h3 className="font-medium">
										{t("documentation:agent.generated")}
									</h3>
									<p className="text-sm text-[var(--text-secondary)]">
										{t("documentation:agent.generatedSummary", {
											types: result.doc_types_processed.length,
											files: result.generated_files.length,
										})}
									</p>
								</div>
							</div>

							{/* Coverage stats */}
							{result.coverage_before && result.coverage_after && (
								<div className="grid grid-cols-2 gap-3 mb-3">
									<div className="bg-[var(--bg-secondary)] rounded-lg p-3 text-center">
										<div className="text-xl font-bold">
											{Math.round(
												result.coverage_before.coverage_percent * 100,
											)}
											%
										</div>
										<div className="text-xs text-[var(--text-secondary)]">
											{t("documentation:agent.coverageBefore")}
										</div>
									</div>
									<div className="bg-[var(--bg-secondary)] rounded-lg p-3 text-center">
										<div className="text-xl font-bold text-green-400">
											{Math.round(result.coverage_after.coverage_percent * 100)}
											%
										</div>
										<div className="text-xs text-[var(--text-secondary)]">
											{t("documentation:agent.coverageAfter")}
										</div>
									</div>
								</div>
							)}

							{/* Files created */}
							{result.generated_files.length > 0 && (
								<div>
									<h4 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-1">
										{t("documentation:agent.filesCreated")}
									</h4>
									<div className="flex flex-col gap-0.5">
										{result.generated_files.map((f) => (
											<div
												key={`file-${f.slice(0, 50)}`}
												className="text-xs font-mono text-[var(--text-secondary)] truncate"
											>
												{f}
											</div>
										))}
									</div>
								</div>
							)}

							{/* Outdated docs found */}
							{result.outdated_found > 0 && (
								<div className="mt-2">
									<h4 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-1">
										{t("documentation:agent.outdatedFound")}
									</h4>
									<div className="text-xs text-yellow-400/80">
										{t("documentation:agent.outdatedCount", {
											count: result.outdated_found,
										})}
									</div>
								</div>
							)}
						</div>
					)}

					{/* Streaming output */}
					<div className="flex-1 overflow-auto p-4">
						{streamingOutput ? (
							<pre className="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
								{streamingOutput}
							</pre>
						) : phase === "idle" ? (
							<div className="flex items-center justify-center h-full text-center">
								<div>
									<div className="text-5xl mb-4">📝</div>
									<h3 className="text-lg font-medium mb-2">
										{t("documentation:title")}
									</h3>
									<p className="text-sm text-[var(--text-secondary)] max-w-sm">
										{t("documentation:agent.idleHint")}
									</p>
								</div>
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}

export default DocumentationAgentDashboard;
