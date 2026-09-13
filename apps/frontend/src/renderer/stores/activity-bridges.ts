import { useAccessibilityStore } from "./accessibility-store";
import { bridgeActivity, bridgePhaseActivity } from "./activity-bridge";
import { useAgentCoachStore } from "./agent-coach-store";
import { useApiWatcherStore } from "./api-watcher-store";
import { useCarbonProfilerStore } from "./carbon-profiler-store";
import { useCodePlaygroundStore } from "./code-playground-store";
import { useComplianceStore } from "./compliance-store";
import { useContextMeshStore } from "./context-mesh-store";
import { useDocDriftStore } from "./doc-drift-store";
import { useFlakyTestsStore } from "./flaky-tests-store";
import { useGitSurgeonStore } from "./git-surgeon-store";
import { useI18nAgentStore } from "./i18n-agent-store";
import { useIdeationStore } from "./ideation-store";
import { useInjectionGuardStore } from "./injection-guard-store";
import { useLearningLoopStore } from "./learning-loop-store";
import { useNotebookAgentStore } from "./notebook-agent-store";
import { useOnboardingAgentStore } from "./onboarding-agent-store";
import { usePromptOptimizerStore } from "./prompt-optimizer-store";
import { useRoadmapStore } from "./roadmap-store";
import { useSpecRefinementStore } from "./spec-refinement-store";
import { useTestGenerationStore } from "./test-generation-store";

/**
 * Which feature reports to the activity registry, and under which menu entry.
 *
 * The mapping lives here rather than in each store so that a feature store
 * stays ignorant of the sidebar: it publishes a phase, and this file decides
 * that the phase means something to a menu entry. Adding a feature is one line
 * here, not an import of the UI inside a store.
 *
 * Deliberately absent:
 *
 * - **self-healing**, whose only running flag is `isLoading` — a data fetch.
 *   Badging a menu entry for a list refresh is the noise this design exists to
 *   avoid.
 * - **smart-estimation**, **conflict-predictor** and the other dialogs with no
 *   `SidebarView` of their own: a badge needs an entry to sit on.
 */
export function setupActivityBridges(): () => void {
	const unsubscribes = [
		// The shared `idle | <verb> | complete | error` shape.
		bridgePhaseActivity(useAccessibilityStore, "accessibility-agent"),
		bridgePhaseActivity(useAgentCoachStore, "agent-coach"),
		bridgePhaseActivity(useApiWatcherStore, "api-watcher"),
		bridgePhaseActivity(useCarbonProfilerStore, "carbon-profiler"),
		bridgePhaseActivity(useCodePlaygroundStore, "code-playground"),
		bridgePhaseActivity(useComplianceStore, "compliance"),
		bridgePhaseActivity(useContextMeshStore, "context-mesh"),
		bridgePhaseActivity(useDocDriftStore, "doc-drift"),
		bridgePhaseActivity(useFlakyTestsStore, "flaky-tests"),
		bridgePhaseActivity(useGitSurgeonStore, "git-surgeon"),
		bridgePhaseActivity(useI18nAgentStore, "i18n-agent"),
		bridgePhaseActivity(useInjectionGuardStore, "injection-guard"),
		bridgePhaseActivity(useLearningLoopStore, "learning-loop"),
		bridgePhaseActivity(useNotebookAgentStore, "notebook-agent"),
		bridgePhaseActivity(useOnboardingAgentStore, "onboarding-agent"),
		bridgePhaseActivity(usePromptOptimizerStore, "prompt-optimizer"),
		bridgePhaseActivity(useSpecRefinementStore, "spec-refinement"),
		bridgePhaseActivity(useTestGenerationStore, "test-generation"),

		// The three that keep their phase somewhere of their own.
		bridgeActivity(useRoadmapStore, {
			view: "roadmap",
			labelKey: "navigation:activity.kinds.generating",
			projectId: (state) => state.currentProjectId,
			phase: (state) => {
				switch (state.generationStatus.phase) {
					case "idle":
						return "idle";
					case "complete":
						return "success";
					case "error":
						return "error";
					default:
						return "running";
				}
			},
			detail: (state) => state.generationStatus.error,
		}),

		bridgeActivity(useIdeationStore, {
			view: "ideation",
			labelKey: "navigation:activity.kinds.ideation",
			projectId: (state) => state.currentProjectId,
			phase: (state) => {
				// `isGenerating` is the authority while it runs; the status phase
				// is what says how it ended, including the timeout path that never
				// touches `isGenerating` through a completion event.
				if (state.isGenerating) return "running";
				switch (state.generationStatus.phase) {
					case "complete":
						return "success";
					case "error":
						return "error";
					default:
						return "idle";
				}
			},
			detail: (state) => state.generationStatus.error,
		}),
	];

	return () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
	};
}
