import { architectureVisualizerService } from "./architecture-visualizer-service";
import { autoRefactorService } from "./auto-refactor-service";
import { codeMigrationService } from "./code-migration-service";
import { documentationAgentService } from "./documentation-agent-service";
import { performanceProfilerService } from "./performance-profiler-service";
import { pipelineGeneratorService } from "./pipeline-generator-service";
import { visualProgrammingService } from "./visual-programming-service";
import { voiceControlService } from "./voice-control-service";

/**
 * Point the feature services that spawn a backend runner at the managed Python
 * and backend directory.
 *
 * The main process decides both: the renderer used to be able to set them over
 * a `<feature>:configure` channel, which made any path it sent the interpreter
 * of the next run. Those channels are gone (audit of 17 Oct, lot M6).
 */
export function configurePythonFeatureServices(
	pythonPath: string,
	autoBuildPath?: string,
): void {
	for (const service of [
		architectureVisualizerService,
		autoRefactorService,
		codeMigrationService,
		documentationAgentService,
		performanceProfilerService,
		pipelineGeneratorService,
		visualProgrammingService,
		voiceControlService,
	]) {
		service.configure(pythonPath, autoBuildPath);
	}
}
