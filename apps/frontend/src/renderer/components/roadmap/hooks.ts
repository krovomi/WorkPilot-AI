import i18n from "i18next";
import { useEffect, useState } from "react";
import type { RoadmapFeature } from "../../../shared/types";
import {
	generateRoadmap,
	loadRoadmap,
	refreshRoadmap,
	stopRoadmap,
	useRoadmapStore,
} from "../../stores/roadmap-store";
import { useTaskStore } from "../../stores/task-store";
import { toast } from "../../hooks/use-toast";

/**
 * Hook to manage roadmap data and loading
 *
 * When the projectId changes, this hook:
 * 1. Loads the new project's roadmap data
 * 2. Queries the backend to check if generation is running for this project
 * 3. Restores the generation status UI state accordingly
 *
 * NOTE: Generation continues in the background when switching projects.
 * The loadRoadmap function queries the backend to restore the correct UI state.
 */
export function useRoadmapData(projectId: string) {
	const roadmap = useRoadmapStore((state) => state.roadmap);
	const competitorAnalysis = useRoadmapStore(
		(state) => state.competitorAnalysis,
	);
	const generationStatus = useRoadmapStore((state) => state.generationStatus);

	useEffect(() => {
		// Load roadmap data and query generation status for this project
		// The loadRoadmap function handles checking if generation is running
		// and restores the UI state accordingly
		loadRoadmap(projectId);
	}, [projectId]);

	return {
		roadmap,
		competitorAnalysis,
		generationStatus,
	};
}

/**
 * Hook to manage feature actions (convert, link, etc.)
 */
export function useFeatureActions() {
	const updateFeatureLinkedSpec = useRoadmapStore(
		(state) => state.updateFeatureLinkedSpec,
	);
	const addTask = useTaskStore((state) => state.addTask);

	const convertFeatureToSpec = async (
		projectId: string,
		feature: RoadmapFeature,
		selectedFeature: RoadmapFeature | null,
		setSelectedFeature: (feature: RoadmapFeature | null) => void,
	) => {
		const result = await window.electronAPI.convertFeatureToSpec(
			projectId,
			feature.id,
		);
		if (!result.success || !result.data) {
			// A refused conversion is said, not left as a button that did nothing.
			toast({
				variant: "destructive",
				title: i18n.t("roadmap:errors.convertFailed", {
					error: result.error ?? i18n.t("roadmap:errors.unknown"),
				}),
			});
			return;
		}
		// Add the created task to the task store so it appears in the kanban immediately
		addTask(result.data);

		// Update the roadmap feature with the linked spec
		updateFeatureLinkedSpec(feature.id, result.data.specId);
		if (selectedFeature?.id === feature.id) {
			setSelectedFeature({
				...feature,
				linkedSpecId: result.data.specId,
				status: "in_progress",
			});
		}
	};

	return {
		convertFeatureToSpec,
	};
}

/**
 * Writes the roadmap as the store holds it now. A refusal (on a server
 * project, a teammate saved first) shows what is saved rather than an edit
 * that is not; a failure is said.
 */
async function persistRoadmap(projectId: string) {
	const roadmap = useRoadmapStore.getState().roadmap;
	if (!roadmap) return;
	try {
		const result = await window.electronAPI.saveRoadmap(projectId, roadmap);
		if (!result.success) await loadRoadmap(projectId);
	} catch {
		toast({ variant: "destructive", title: i18n.t("roadmap:save.saveError") });
	}
}

/**
 * Hook to save roadmap changes to disk
 *
 * NOTE: Gets roadmap from store at call time (not render time) to ensure
 * we save the latest state after Zustand updates (e.g., after drag-drop status change)
 */
export function useRoadmapSave(projectId: string) {
	const saveRoadmap = () => persistRoadmap(projectId);
	return { saveRoadmap };
}

/**
 * Hook to delete features from roadmap
 */
export function useFeatureDelete(projectId: string) {
	const deleteFeature = useRoadmapStore((state) => state.deleteFeature);

	const handleDeleteFeature = async (featureId: string) => {
		deleteFeature(featureId);
		await persistRoadmap(projectId);
	};

	return { deleteFeature: handleDeleteFeature };
}

/**
 * Hook to manage roadmap generation actions
 *
 * Handles two scenarios:
 * 1. No existing competitor analysis: Show simple enable/skip dialog
 * 2. Existing competitor analysis: Show options to use existing, run new, or skip
 */
export function useRoadmapGeneration(projectId: string) {
	const competitorAnalysis = useRoadmapStore(
		(state) => state.competitorAnalysis,
	);
	const [pendingAction, setPendingAction] = useState<
		"generate" | "refresh" | null
	>(null);
	const [showCompetitorDialog, setShowCompetitorDialog] = useState(false);
	const [showExistingAnalysisDialog, setShowExistingAnalysisDialog] =
		useState(false);

	// Generating and refreshing first ask about competitor analysis: whether to
	// reuse the saved one when there is one, whether to run one otherwise.
	const ask = (action: "generate" | "refresh") => {
		setPendingAction(action);
		if (competitorAnalysis) setShowExistingAnalysisDialog(true);
		else setShowCompetitorDialog(true);
	};
	const handleGenerate = () => ask("generate");
	const handleRefresh = () => ask("refresh");

	// Every choice of the two dialogs runs the action that opened them
	// (generate or refresh) with its competitor analysis settings: enable it,
	// and run fresh web searches (true) or reuse the saved analysis (false).
	const run = (enableAnalysis: boolean, refreshAnalysis?: boolean) => {
		const action = pendingAction === "refresh" ? refreshRoadmap : generateRoadmap;
		action(projectId, enableAnalysis, refreshAnalysis);
		setPendingAction(null);
	};
	const handleCompetitorDialogAccept = () => run(true);
	const handleCompetitorDialogDecline = () => run(false);
	const handleUseExistingAnalysis = () => run(true, false);
	const handleRunNewAnalysis = () => run(true, true);
	const handleSkipAnalysis = () => run(false);

	const handleStop = async () => {
		await stopRoadmap(projectId);
	};

	return {
		competitorAnalysisDate: competitorAnalysis?.createdAt,
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
	};
}
