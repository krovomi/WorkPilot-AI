import { useState } from "react";
import type { RoadmapFeature } from "../../shared/types";
import { useServerViewLive } from "../hooks/useServerViewLive";
import { AddFeatureDialog } from "./AddFeatureDialog";
import { ModuleStage } from "./charter";
import { CompetitorAnalysisDialog } from "./CompetitorAnalysisDialog";
import { CompetitorAnalysisViewer } from "./CompetitorAnalysisViewer";
import { ExistingCompetitorAnalysisDialog } from "./ExistingCompetitorAnalysisDialog";
import { RoadmapGenerationProgress } from "./RoadmapGenerationProgress";
import { FeatureDetailPanel } from "./roadmap/FeatureDetailPanel";
import {
	useFeatureActions,
	useFeatureDelete,
	useRoadmapData,
	useRoadmapGeneration,
	useRoadmapSave,
} from "./roadmap/hooks";
import { RoadmapEmptyState } from "./roadmap/RoadmapEmptyState";
import { RoadmapHeader } from "./roadmap/RoadmapHeader";
import { RoadmapTabs } from "./roadmap/RoadmapTabs";
import type { RoadmapProps } from "./roadmap/types";
import { getCompetitorInsightsForFeature } from "./roadmap/utils";

export function Roadmap({ projectId, onGoToTask }: Readonly<RoadmapProps>) {
	// A server project's roadmap shows a teammate's change at once.
	useServerViewLive(projectId, "roadmap");
	// State management
	const [selectedFeature, setSelectedFeature] = useState<RoadmapFeature | null>(
		null,
	);
	const [activeTab, setActiveTab] = useState("kanban");
	const [showAddFeatureDialog, setShowAddFeatureDialog] = useState(false);
	const [showCompetitorViewer, setShowCompetitorViewer] = useState(false);

	// Custom hooks
	const { roadmap, competitorAnalysis, generationStatus } =
		useRoadmapData(projectId);
	const { convertFeatureToSpec } = useFeatureActions();
	const { saveRoadmap } = useRoadmapSave(projectId);
	const { deleteFeature } = useFeatureDelete(projectId);
	const {
		competitorAnalysisDate,
		// New dialog for existing analysis
		showExistingAnalysisDialog,
		setShowExistingAnalysisDialog,
		handleUseExistingAnalysis,
		handleRunNewAnalysis,
		handleSkipAnalysis,
		// Original dialog for no existing analysis
		showCompetitorDialog,
		setShowCompetitorDialog,
		handleGenerate,
		handleRefresh,
		handleCompetitorDialogAccept,
		handleCompetitorDialogDecline,
		handleStop,
	} = useRoadmapGeneration(projectId);

	// Event handlers
	const handleConvertToSpec = async (feature: RoadmapFeature) => {
		await convertFeatureToSpec(
			projectId,
			feature,
			selectedFeature,
			setSelectedFeature,
		);
	};

	const handleGoToTask = (specId: string) => {
		if (onGoToTask) {
			onGoToTask(specId);
		}
	};

	// Show generation progress
	if (
		generationStatus.phase !== "idle" &&
		generationStatus.phase !== "complete"
	) {
		return (
			<ModuleStage data-testid="roadmap-view">
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					<RoadmapGenerationProgress
						generationStatus={generationStatus}
						className="w-full max-w-md"
						onStop={handleStop}
					/>
				</div>
			</ModuleStage>
		);
	}

	// Show empty state
	if (!roadmap) {
		return (
			<>
				<RoadmapEmptyState onGenerate={handleGenerate} />
				{/* Dialog for projects WITHOUT existing competitor analysis */}
				<CompetitorAnalysisDialog
					open={showCompetitorDialog}
					onOpenChange={setShowCompetitorDialog}
					onAccept={handleCompetitorDialogAccept}
					onDecline={handleCompetitorDialogDecline}
				/>
				{/* Dialog for projects WITH existing competitor analysis */}
				<ExistingCompetitorAnalysisDialog
					open={showExistingAnalysisDialog}
					onOpenChange={setShowExistingAnalysisDialog}
					onUseExisting={handleUseExistingAnalysis}
					onRunNew={handleRunNewAnalysis}
					onSkip={handleSkipAnalysis}
					analysisDate={competitorAnalysisDate}
				/>
			</>
		);
	}

	// Main roadmap view
	return (
		<ModuleStage data-testid="roadmap-view">
			{/* Header */}
			<RoadmapHeader
				roadmap={roadmap}
				competitorAnalysis={competitorAnalysis}
				onAddFeature={() => setShowAddFeatureDialog(true)}
				onRefresh={handleRefresh}
				onViewCompetitorAnalysis={() => setShowCompetitorViewer(true)}
			/>

			{/* Content */}
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<RoadmapTabs
					roadmap={roadmap}
					activeTab={activeTab}
					onTabChange={setActiveTab}
					onFeatureSelect={setSelectedFeature}
					onConvertToSpec={handleConvertToSpec}
					onGoToTask={handleGoToTask}
					onSave={saveRoadmap}
				/>
			</div>

			{/* Feature Detail Panel */}
			{selectedFeature && (
				<FeatureDetailPanel
					feature={selectedFeature}
					onClose={() => setSelectedFeature(null)}
					onConvertToSpec={handleConvertToSpec}
					onGoToTask={handleGoToTask}
					onDelete={deleteFeature}
					competitorInsights={getCompetitorInsightsForFeature(
						selectedFeature,
						competitorAnalysis,
					)}
				/>
			)}

			{/* Competitor Analysis Permission Dialog (no existing analysis) */}
			<CompetitorAnalysisDialog
				open={showCompetitorDialog}
				onOpenChange={setShowCompetitorDialog}
				onAccept={handleCompetitorDialogAccept}
				onDecline={handleCompetitorDialogDecline}
			/>

			{/* Competitor Analysis Options Dialog (existing analysis) */}
			<ExistingCompetitorAnalysisDialog
				open={showExistingAnalysisDialog}
				onOpenChange={setShowExistingAnalysisDialog}
				onUseExisting={handleUseExistingAnalysis}
				onRunNew={handleRunNewAnalysis}
				onSkip={handleSkipAnalysis}
				analysisDate={competitorAnalysisDate}
			/>

			{/* Competitor Analysis Viewer */}
			<CompetitorAnalysisViewer
				analysis={competitorAnalysis}
				open={showCompetitorViewer}
				onOpenChange={setShowCompetitorViewer}
			/>

			{/* Add Feature Dialog */}
			<AddFeatureDialog
				phases={roadmap.phases}
				open={showAddFeatureDialog}
				onOpenChange={setShowAddFeatureDialog}
			/>
		</ModuleStage>
	);
}
