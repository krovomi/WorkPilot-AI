/**
 * A name for the recorded test and its proposed checks ranked (#387), by the
 * fast model of the provider the person chose, or by rules without one
 * (`browser_recorder_runner.py assist`, `browser_agent/recorder_assist.py`).
 *
 * This is the one recorder runner that gets a provider's environment
 * (`pythonRunnerEnv`: the provider and its key, nothing else inherited): it
 * sends the model what the steps say of the page, never a value typed.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { parseAssist, type RecorderAssistOutcome } from "../../shared/types/browser-recorder-run";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";
import { runnerResult } from "./recorder-run";
import { backendPath, type SpawnRunner, sessionSteps, sessionSuggestions } from "./recorder-session";

export const ASSIST_PREFIX = "RECORDER_ASSIST:";

/** Starts the recorder runner with the chosen provider's environment, without a shell. */
export const spawnAssistRunner: SpawnRunner = async (args) => {
	const backend = await backendPath();
	const runner = path.resolve(backend, "runners", "browser_recorder_runner.py");
	const python = await requirePythonPath();
	return spawn(python, [runner, ...args], { cwd: backend, env: await pythonRunnerEnv(backend) });
};

export async function assistRecording(
	projectPath: string,
	spawnRunner: SpawnRunner = spawnAssistRunner,
): Promise<RecorderAssistOutcome> {
	const steps = sessionSteps(projectPath);
	if (!steps.length) return { success: false, error: "Stop a recording first: its steps are named." };
	const suggestions = sessionSuggestions(projectPath);
	try {
		const raw = await runnerResult(
			spawnRunner,
			["assist", `--project=${projectPath}`],
			ASSIST_PREFIX,
			JSON.stringify({ steps, suggestions }),
		);
		const assist = parseAssist(
			raw,
			suggestions.map((s) => s.id),
		);
		return assist ? { success: true, assist } : { success: false, error: "The assistant gave no answer." };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}
