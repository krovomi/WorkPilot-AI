import { OctagonX } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { useProjectStore } from "../../stores/project-store";
import { loadTasks, useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** A task with an agent behind it, as far as the board knows. */
export function isAgentRunning(task: Task): boolean {
	return (
		(task.status === "in_progress" || task.status === "ai_review") &&
		!task.metadata?.paused?.enabled &&
		!task.metadata?.archivedAt
	);
}

/** Ctrl+Shift+. (Cmd+Shift+. on macOS), wherever the focus is. */
export function isStopAllShortcut(event: KeyboardEvent): boolean {
	return (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "Period";
}

/**
 * "Stop all agents" (the kill switch): shown in the sidebar rail while an
 * agent runs, and on its shortcut at any time. Every running task is paused,
 * to be resumed one by one; every other agent process is stopped. The main
 * process decides what runs: the button sends no argument.
 */
export function StopAllAgentsButton() {
	const { t } = useTranslation(["navigation"]);
	const { toast } = useToast();
	const running = useTaskStore((s) => s.tasks.some(isAgentRunning));
	const busy = useRef(false);

	const stopAll = useCallback(async () => {
		if (busy.current) return;
		busy.current = true;
		try {
			const result = await globalThis.electronAPI.stopAllAgents();
			const data = result.data;
			if (!result.success || !data) {
				toast({ variant: "destructive", title: t("navigation:stopAll.failed") });
				return;
			}
			const paused = data.pausedTasks.length + data.failedTasks.length;
			const server = data.serverAgents ?? 0;
			const unreachable = data.serverFailed ?? 0;
			const serverLines = [
				server > 0 ? t("navigation:stopAll.serverDone", { count: server }) : null,
				unreachable > 0 ? t("navigation:stopAll.serverFailed", { count: unreachable }) : null,
			].filter(Boolean);
			toast(
				paused + data.stoppedProcesses + server === 0
					? {
							title: t("navigation:stopAll.nothing"),
							...(serverLines.length ? { description: serverLines.join(" ") } : {}),
						}
					: {
							title: t("navigation:stopAll.done", { count: paused }),
							description: [t("navigation:stopAll.resumeHint"), ...serverLines].join(" "),
						},
			);
			const projectId = useProjectStore.getState().selectedProjectId;
			if (projectId) await loadTasks(projectId, { forceRefresh: true });
		} finally {
			busy.current = false;
		}
	}, [t, toast]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isStopAllShortcut(event)) return;
			event.preventDefault();
			void stopAll();
		};
		// Capture: the shortcut works while typing in a field too.
		globalThis.addEventListener("keydown", onKeyDown, true);
		return () => globalThis.removeEventListener("keydown", onKeyDown, true);
	}, [stopAll]);

	if (!running) return null;
	const label = t("navigation:stopAll.label");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={() => void stopAll()}
					aria-label={label}
					data-testid="stop-all-agents"
				>
					<OctagonX className="h-4 w-4" />
				</Button>
			</TooltipTrigger>
			<TooltipContent side="right">{t("navigation:stopAll.tooltip")}</TooltipContent>
		</Tooltip>
	);
}
