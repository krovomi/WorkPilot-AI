import { afterEach, expect, it, vi } from "vitest";
import type { AppSettings, Task } from "../../shared/types";
import { applyProviderToTasks } from "./apply-provider-to-tasks";
import { persistUpdateTask } from "../stores/task-store";
vi.mock("../stores/task-store", () => ({ persistUpdateTask: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
it("persists every task and requests a live switch only for active execution", async () => {
 vi.mocked(persistUpdateTask).mockResolvedValue(true);
 const hotSwapPhase = vi.fn().mockResolvedValue({ success: true });
 vi.stubGlobal("electronAPI", { hotSwapPhase });
 const tasks = [ { id: "idle", status: "backlog" }, { id: "running", status: "in_progress", executionProgress: { phase: "coding" } } ] as Task[];
 expect(await applyProviderToTasks(tasks, "openai", {} as AppSettings)).toEqual([]);
 expect(persistUpdateTask).toHaveBeenCalledTimes(2);
 expect(hotSwapPhase).toHaveBeenCalledTimes(1);
 expect(hotSwapPhase).toHaveBeenCalledWith("running", "coding", expect.objectContaining({ provider: "openai" }));
});
it("reports failures and continues updating the remaining tasks", async () => {
 vi.mocked(persistUpdateTask).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 const tasks = [{ id: "first", status: "backlog" }, { id: "second", status: "backlog" }] as Task[];
 expect(await applyProviderToTasks(tasks, "anthropic", {} as AppSettings)).toEqual(["first"]);
 expect(persistUpdateTask).toHaveBeenCalledTimes(2);
});
