import { debugWarn } from "../../shared/utils/debug-logger";

import { setupAccessibilityListeners } from "./accessibility-store";
import { setupAgentCoachListeners } from "./agent-coach-store";
import { setupApiWatcherListeners } from "./api-watcher-store";
import { setupAppEmulatorListeners } from "./app-emulator-store";
import { setupArchitectureDeltaListeners } from "./architecture-delta-store";
import {
	setupArchitectureVisualizerListeners,
} from "./architecture-visualizer-store";
import { setupAutoRefactorListeners } from "./auto-refactor-store";
import { setupCarbonProfilerListeners } from "./carbon-profiler-store";
import { setupCodeMigrationListeners } from "./code-migration-store";
import { setupCodePlaygroundListeners } from "./code-playground-store";
import { setupComplianceListeners } from "./compliance-store";
import { setupConflictPredictorListeners } from "./conflict-predictor-store";
import { setupConsensusArbiterListeners } from "./consensus-arbiter-store";
import {
	setupContextAwareSnippetsListeners,
} from "./context-aware-snippets-store";
import { setupDocDriftListeners } from "./doc-drift-store";
import { setupDocumentationAgentListeners } from "./documentation-agent-store";
import { setupFlakyTestsListeners } from "./flaky-tests-store";
import { setupGitSurgeonListeners } from "./git-surgeon-store";
import { setupIdeationListeners } from "./ideation-store";
import { setupInjectionGuardListeners } from "./injection-guard-store";
import { setupInsightsListeners } from "./insights-store";
import { setupLearningLoopListeners } from "./learning-loop-store";
import { setupMobileListeners } from "./mobile-store";
import { setupNaturalLanguageGitListeners } from "./natural-language-git-store";
import { setupNotebookAgentListeners } from "./notebook-agent-store";
import { setupOnboardingAgentListeners } from "./onboarding-agent-store";
import { setupPairProgrammingListeners } from "./pair-programming-store";
import {
	setupPerformanceProfilerListeners,
} from "./performance-profiler-store";
import { setupPairRealtimeListeners } from "./phase35-stores";
import { setupPipelineGeneratorListeners } from "./pipeline-generator-store";
import { setupPromptOptimizerListeners } from "./prompt-optimizer-store";
import { setupRegressionGuardianListeners } from "./regression-guardian-store";
import { setupReleaseCoordinatorListeners } from "./release-coordinator-store";
import { setupSandboxListeners } from "./sandbox-store";
import { setupSmartEstimationListeners } from "./smart-estimation-store";
import { setupSpecRefinementListeners } from "./spec-refinement-store";
import { setupVoiceControlListeners } from "./voice-control-store";

/**
 * Every feature's IPC listeners, registered once for the lifetime of the
 * window instead of once per page visit.
 *
 * They used to be registered by the page component itself, in a `useEffect`
 * whose cleanup ran on unmount — and `App.tsx` unmounts a view as soon as the
 * user navigates elsewhere. The work never stopped (it runs in the main
 * process), but nobody was listening any more: progress events fell on the
 * floor, the store stayed on `isGenerating: true` for ever, and the page came
 * back showing a run that had finished ten minutes earlier.
 *
 * A page is a view onto work, not its owner. So the subscription belongs to
 * the session, and the page only reads what the store already knows.
 */

/** Returns a teardown, or nothing at all — both shapes exist in the stores. */
type ListenerSetup = () => unknown;

/** Named so a failing entry can be reported without a stack trace. */
const SETUPS: ReadonlyArray<readonly [string, ListenerSetup]> = [
	["Accessibility", setupAccessibilityListeners],
	["AgentCoach", setupAgentCoachListeners],
	["ApiWatcher", setupApiWatcherListeners],
	["AppEmulator", setupAppEmulatorListeners],
	["ArchitectureDelta", setupArchitectureDeltaListeners],
	["ArchitectureVisualizer", setupArchitectureVisualizerListeners],
	["AutoRefactor", setupAutoRefactorListeners],
	["CarbonProfiler", setupCarbonProfilerListeners],
	["CodeMigration", setupCodeMigrationListeners],
	["CodePlayground", setupCodePlaygroundListeners],
	["Compliance", setupComplianceListeners],
	["ConflictPredictor", setupConflictPredictorListeners],
	["ConsensusArbiter", setupConsensusArbiterListeners],
	["ContextAwareSnippets", setupContextAwareSnippetsListeners],
	["DocDrift", setupDocDriftListeners],
	["DocumentationAgent", setupDocumentationAgentListeners],
	["FlakyTests", setupFlakyTestsListeners],
	["GitSurgeon", setupGitSurgeonListeners],
	["Ideation", setupIdeationListeners],
	["InjectionGuard", setupInjectionGuardListeners],
	["Insights", setupInsightsListeners],
	["LearningLoop", setupLearningLoopListeners],
	["Mobile", setupMobileListeners],
	["NaturalLanguageGit", setupNaturalLanguageGitListeners],
	["NotebookAgent", setupNotebookAgentListeners],
	["OnboardingAgent", setupOnboardingAgentListeners],
	["PairProgramming", setupPairProgrammingListeners],
	["PairRealtime", setupPairRealtimeListeners],
	["PerformanceProfiler", setupPerformanceProfilerListeners],
	["PipelineGenerator", setupPipelineGeneratorListeners],
	["PromptOptimizer", setupPromptOptimizerListeners],
	["RegressionGuardian", setupRegressionGuardianListeners],
	["ReleaseCoordinator", setupReleaseCoordinatorListeners],
	["Sandbox", setupSandboxListeners],
	["SmartEstimation", setupSmartEstimationListeners],
	["SpecRefinement", setupSpecRefinementListeners],
	["VoiceControl", setupVoiceControlListeners],
];

let teardown: (() => void) | null = null;

/**
 * Registers everything, and returns the teardown. Calling it twice without
 * tearing down in between is a no-op: React 18 remounts effects in
 * development, and double registration would make every event fire twice —
 * which for the stores that append (ideas, logs, findings) means duplicated
 * content, not just wasted work.
 */
export function setupGlobalListeners(): () => void {
	if (teardown) return teardown;

	const cleanups: Array<() => void> = [];

	for (const [name, setup] of SETUPS) {
		try {
			const cleanup = setup();
			if (typeof cleanup === "function") {
				cleanups.push(cleanup as () => void);
			}
		} catch (error) {
			// One feature whose preload API is missing (a mock bridge, a build
			// without that module) must not take the other thirty-six with it.
			debugWarn(`[globalListeners] ${name} failed to register:`, error);
		}
	}

	teardown = () => {
		teardown = null;
		for (const cleanup of cleanups) {
			try {
				cleanup();
			} catch {
				// Teardown runs while the window is going away; a listener that
				// cannot unregister is not worth failing the unmount over.
			}
		}
	};

	return teardown;
}

/** Test seam: forget the registration without running the cleanups. */
export function resetGlobalListenersForTests(): void {
	teardown = null;
}
