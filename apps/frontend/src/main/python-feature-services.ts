import { architectureVisualizerService } from "./architecture-visualizer-service";
import { autoRefactorService } from "./auto-refactor-service";
import { codeMigrationService } from "./code-migration-service";
import { codePlaygroundService } from "./code-playground-service";
import { contextMeshService } from "./context-mesh-service";
import { learningLoopService } from "./learning-loop-service";
import { liveCompanionService } from "./live-companion-service";
import { mobileService } from "./mobile-service";
import { naturalLanguageGitService } from "./natural-language-git-service";
import { performanceProfilerService } from "./performance-profiler-service";
import { pipelineGeneratorService } from "./pipeline-generator-service";
import { specInterviewService } from "./spec-interview-service";
import { visualProgrammingService } from "./visual-programming-service";
import { voiceControlService } from "./voice-control-service";

/**
 * Point the feature services that spawn a backend runner at the managed Python
 * and backend directory.
 *
 * The main process decides both: the renderer used to be able to set them over
 * a `<feature>:configure` channel, which made any path it sent the interpreter
 * of the next run. Those channels are gone (audit of 17 Oct, lot M6).
 *
 * Every service with a `configure(pythonPath, backendPath)` belongs here: one
 * left out keeps its default `"python"`, the system interpreter without the
 * backend's dependencies (absent altogether on a stock macOS or Windows).
 */
export function configurePythonFeatureServices(
	pythonPath: string,
	autoBuildPath?: string,
): void {
	for (const service of [
		architectureVisualizerService,
		autoRefactorService,
		codeMigrationService,
		codePlaygroundService,
		contextMeshService,
		learningLoopService,
		liveCompanionService,
		mobileService,
		naturalLanguageGitService,
		performanceProfilerService,
		pipelineGeneratorService,
		specInterviewService,
		visualProgrammingService,
		voiceControlService,
	]) {
		service.configure(pythonPath, autoBuildPath);
	}
}
