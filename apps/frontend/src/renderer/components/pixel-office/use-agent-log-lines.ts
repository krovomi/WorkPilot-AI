/**
 * The log lines the Pixel Office bubble shows for a task.
 *
 * Two sources, the same ones the task panel reads:
 *
 * - the task's phase log (`task_logs.json` locally, the card's log feed on a
 *   server), written by the pipeline for every provider and kept after the
 *   task ends. It is loaded when the bubble opens and watched while it stays
 *   open, so a running task's log grows in place and a finished one is
 *   there at once;
 * - the agent's own output streamed into `task.logs`, which only exists for a
 *   task this window saw running on this computer.
 *
 * The phase log wins when it has anything: it is complete, it is what the
 * Kanban's Logs tab shows, and it is the only source on a server or after a
 * restart. The live output fills in until the first phase entry is written.
 * The bubble used to read the phase log once, and only when there was no
 * live output, so a server card or a card a page opened (which writes no
 * live output) stayed on "waiting for logs" for good.
 */
import { useEffect, useMemo, useState } from "react";
import { stripAnsiCodes } from "../../../shared/utils/ansi-sanitizer";
import { flattenTaskLogsToLines } from "../../../shared/utils/task-logs";
import { retainTaskLogWatch } from "../../lib/task-log-watch";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";

/** Lines kept on screen; older ones are dropped from the view, not the file. */
export const LOG_KEEP = 5000;

const NO_LINES: readonly string[] = [];

/** Statuses in which more log is still to come. */
const RUNNING_STATUSES = new Set(["in_progress", "ai_review"]);

export interface AgentLogLines {
	/** Clean, non-empty lines, oldest first. */
	readonly lines: readonly string[];
	/** Whether the task can still write more (the empty state says "waiting"). */
	readonly running: boolean;
	/** The phase log has been asked for and has not answered yet. */
	readonly loading: boolean;
}

export function cleanLogLines(source: readonly string[]): string[] {
	return source
		.slice(-LOG_KEEP)
		.map((line) => stripAnsiCodes(line).trim())
		.filter((line) => line.length > 0);
}

export function useAgentLogLines(taskId: string): AgentLogLines {
	const task = useTaskStore((s) => s.tasks.find((t) => t.id === taskId));
	const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
	const liveLogs = task?.logs ?? NO_LINES;
	const specId = task?.specId;
	const projectId = task?.projectId || selectedProjectId || undefined;
	const status = task?.status;
	const [persisted, setPersisted] = useState<readonly string[]>(NO_LINES);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		setPersisted(NO_LINES);
		if (!projectId || !specId) return;
		let cancelled = false;
		setLoading(true);
		window.electronAPI
			.getTaskLogs(projectId, specId)
			.then((res) => {
				if (!cancelled && res?.success && res.data) {
					setPersisted(flattenTaskLogsToLines(res.data));
				}
			})
			.catch(() => {
				/* best-effort: the live output, if any, still shows */
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		const release = retainTaskLogWatch(projectId, specId);
		const unsubscribe = window.electronAPI.onTaskLogsChanged(
			(changedSpecId, logs) => {
				if (cancelled || changedSpecId !== specId) return;
				setPersisted(flattenTaskLogsToLines(logs));
			},
		);
		return () => {
			cancelled = true;
			unsubscribe?.();
			release();
		};
	}, [projectId, specId]);

	const lines = useMemo(() => {
		const fromLog = cleanLogLines(persisted);
		return fromLog.length > 0 ? fromLog : cleanLogLines(liveLogs);
	}, [persisted, liveLogs]);

	return {
		lines,
		running: status !== undefined && RUNNING_STATUSES.has(status),
		loading,
	};
}
