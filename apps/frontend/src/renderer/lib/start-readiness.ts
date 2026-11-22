/**
 * The renderer half of the pre-analysis before « En cours »
 * (docs/architecture/task-readiness.md): asks the main process, says so while
 * a short card is read, and holds the card when it should not start yet.
 */
import i18n from "i18next";
import type { Task } from "../../shared/types";
import { isFirstStart, isShortCard } from "../../shared/utils/task-readiness";
import { toast } from "../hooks/use-toast";
import { useTaskReadinessStore } from "../stores/task-readiness-store";

/** Whether the card may start now; false holds it for the readiness dialog. */
export async function readyToStart(task: Task): Promise<boolean> {
	const store = useTaskReadinessStore.getState();
	if (!isFirstStart(task) || store.accepted.has(task.id)) return true;
	const reading = isShortCard(task)
		? toast({ title: i18n.t("tasks:readiness.checking", { title: task.title }) })
		: null;
	try {
		const result = await globalThis.electronAPI.checkTaskReadiness(task.id);
		if (!result.success || !result.data || result.data.ready) return true;
		store.hold(task.id, result.data);
		return false;
	} catch {
		// The pre-analysis helps; it never stands in the way of a start.
		return true;
	} finally {
		reading?.dismiss();
	}
}
