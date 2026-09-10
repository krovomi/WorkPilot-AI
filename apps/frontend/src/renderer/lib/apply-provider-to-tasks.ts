import type { AppSettings, Task } from "../../shared/types";
import { buildGlobalProviderMetadataUpdate } from "../../shared/utils/task-thinking";
import { persistUpdateTask } from "../stores/task-store";

/** Apply to the task snapshot captured before any asynchronous project switch. */
export async function applyProviderToTasks(tasks: readonly Task[], provider: string, settings: AppSettings): Promise<string[]> {
 const metadata = buildGlobalProviderMetadataUpdate(provider, settings);
 const failed: string[] = [];
 for (const task of tasks) {
  try {
   if (!await persistUpdateTask(task.id, { metadata })) { failed.push(task.id); continue; }
   const phase = task.executionProgress?.phase;
   const configPhase = phase === "planning" ? "planning" : phase === "coding" ? "coding" : phase === "qa_review" || phase === "qa_fixing" ? "qa" : null;
   if ((task.status === "in_progress" || task.status === "ai_review") && configPhase) {
    const result = await globalThis.electronAPI.hotSwapPhase(task.id, configPhase, {
     provider, model: metadata.phaseModels[configPhase], effort: metadata.phaseThinking[configPhase],
    });
    if (!result.success) failed.push(task.id);
   }
  } catch { failed.push(task.id); }
 }
 return failed;
}
