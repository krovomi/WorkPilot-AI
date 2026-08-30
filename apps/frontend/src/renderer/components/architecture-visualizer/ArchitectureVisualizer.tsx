import type React from "react";
import { Trans, useTranslation } from "react-i18next";
import {
	cancelArchitectureVisualization,
	DIAGRAM_TYPES,
	type DiagramType,
	generateArchitectureDiagrams,
	useArchitectureVisualizerStore,
} from "../../stores/architecture-visualizer-store";
import { useProjectStore } from "../../stores/project-store";

const DIAGRAM_ICONS: Record<DiagramType, string> = {
	module_dependencies: "🔗",
	component_hierarchy: "🌳",
	data_flow: "🌊",
	database_schema: "🗄️",
};

export function ArchitectureVisualizer(): React.ReactElement {
	const { t } = useTranslation(["architectureVisualizer"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const {
		phase,
		status,
		streamingOutput,
		result,
		error,
		selectedDiagramTypes,
		selectedDiagramView,
		toggleDiagramType,
		setSelectedDiagramView,
	} = useArchitectureVisualizerStore();

	const isRunning = phase === "generating";
	const isComplete = phase === "complete";

	function handleGenerate() {
		if (!activeProject?.path) return;
		generateArchitectureDiagrams(activeProject.path);
	}

	const diagramLabel = (type: DiagramType) =>
		t(`architectureVisualizer:diagramTypes.${type}`);

	const selectedDiagram =
		result && selectedDiagramView ? result.diagrams[selectedDiagramView] : null;

	return (
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			{/* Header */}
			<div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-color)]">
				<div>
					<h1 className="text-xl font-semibold">
						{t("architectureVisualizer:title")}
					</h1>
					<p className="text-sm text-[var(--text-secondary)] mt-0.5">
						{t("architectureVisualizer:subtitle")}
					</p>
				</div>
				<div className="flex gap-2">
					{isRunning ? (
						<button
							type="button"
							onClick={cancelArchitectureVisualization}
							className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors text-sm font-medium"
						>
							{t("architectureVisualizer:actions.cancel")}
						</button>
					) : (
						<button
							type="button"
							onClick={handleGenerate}
							disabled={!activeProject || selectedDiagramTypes.length === 0}
							className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity text-sm font-medium"
						>
							{isComplete
								? t("architectureVisualizer:actions.regenerate")
								: t("architectureVisualizer:actions.generate")}
						</button>
					)}
				</div>
			</div>

			<div className="flex flex-1 overflow-hidden">
				{/* Left sidebar */}
				<div className="w-56 border-r border-[var(--border-color)] p-4 flex flex-col gap-4">
					{/* Diagram type selection */}
					<div>
						<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
							{t("architectureVisualizer:diagramTypes.heading")}
						</h3>
						<div className="flex flex-col gap-1">
							{DIAGRAM_TYPES.map((type) => (
								<label
									key={type}
									className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--bg-secondary)] cursor-pointer"
								>
									<input
										type="checkbox"
										checked={selectedDiagramTypes.includes(type)}
										onChange={() => toggleDiagramType(type)}
										disabled={isRunning}
										className="rounded accent-[var(--accent)]"
									/>
									<span className="text-sm">
										{DIAGRAM_ICONS[type]} {diagramLabel(type)}
									</span>
								</label>
							))}
						</div>
					</div>

					{/* Diagram view selector (after generation) */}
					{isComplete && result && (
						<div>
							<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
								{t("architectureVisualizer:view.heading")}
							</h3>
							<div className="flex flex-col gap-1">
								{result.diagram_types_analyzed.map((type) => (
									<button
										type="button"
										key={type}
										onClick={() => setSelectedDiagramView(type as DiagramType)}
										className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left transition-colors ${
											selectedDiagramView === type
												? "bg-[var(--accent)]/20 text-[var(--accent)]"
												: "hover:bg-[var(--bg-secondary)]"
										}`}
									>
										{DIAGRAM_ICONS[type as DiagramType]}{" "}
										{diagramLabel(type as DiagramType)}
									</button>
								))}
							</div>
						</div>
					)}

					{/* Summary stats */}
					{isComplete && result?.summary && (
						<div className="mt-auto">
							<h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">
								{t("architectureVisualizer:summary.heading")}
							</h3>
							<div className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
								<div>
									{t("architectureVisualizer:summary.diagrams", {
										count: result.summary.total_diagrams,
									})}
								</div>
								<div>
									{t("architectureVisualizer:summary.nodes", {
										count: result.summary.total_nodes,
									})}
								</div>
								<div>
									{t("architectureVisualizer:summary.edges", {
										count: result.summary.total_edges,
									})}
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Main content */}
				<div className="flex-1 flex flex-col overflow-hidden">
					{/* Status bar */}
					{(isRunning || status) && (
						<div className="px-4 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] text-sm text-[var(--text-secondary)] flex items-center gap-2">
							{isRunning && (
								// biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative
								<svg
									className="animate-spin w-4 h-4 text-[var(--accent)]"
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
							{status}
						</div>
					)}

					{/* Error state */}
					{error && (
						<div className="m-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
							{error}
						</div>
					)}

					{/* Mermaid diagram view */}
					{isComplete && selectedDiagram && (
						<div className="flex-1 overflow-auto p-4">
							<div className="mb-3 flex items-center gap-2">
								<span className="text-lg">
									{DIAGRAM_ICONS[selectedDiagramView as DiagramType]}
								</span>
								<h2 className="text-lg font-medium">{selectedDiagram.title}</h2>
								<span className="text-xs text-[var(--text-secondary)] ml-2">
									{t("architectureVisualizer:diagram.counts", {
										nodes: selectedDiagram.nodes?.length ?? 0,
										edges: selectedDiagram.edges?.length ?? 0,
									})}
								</span>
							</div>
							<div className="bg-[var(--bg-secondary)] rounded-lg p-4 overflow-auto">
								<pre className="text-xs font-mono text-green-400 whitespace-pre overflow-x-auto">
									{selectedDiagram.mermaid_code}
								</pre>
							</div>
							<p className="text-xs text-[var(--text-secondary)] mt-2">
								<Trans
									i18nKey="architectureVisualizer:diagram.copyHint"
									components={[
										// biome-ignore lint/a11y/useAnchorContent: Trans fills the content
										<a
											key="mermaid-live"
											href="https://mermaid.live"
											target="_blank"
											rel="noreferrer"
											className="text-[var(--accent)] hover:underline"
										/>,
									]}
								/>
							</p>
						</div>
					)}

					{/* Streaming log */}
					{(isRunning || (!isComplete && streamingOutput)) && (
						<div className="flex-1 overflow-auto p-4">
							<pre className="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
								{streamingOutput}
							</pre>
						</div>
					)}

					{/* Empty state */}
					{phase === "idle" && !result && (
						<div className="flex-1 flex items-center justify-center text-center p-8">
							<div>
								<div className="text-5xl mb-4">🏗️</div>
								<h3 className="text-lg font-medium mb-2">
									{t("architectureVisualizer:empty.title")}
								</h3>
								<p className="text-sm text-[var(--text-secondary)] max-w-sm">
									{t("architectureVisualizer:empty.body")}
								</p>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

export default ArchitectureVisualizer;
