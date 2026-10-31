import { useCallback, useState } from "react";
import type { GitHubIssue } from "../../../../shared/types";
import { useIssuesStore } from "../../../stores/github/issues-store";
import { useTaskStore } from "../../../stores/task-store";

/**
 * "Create Task" on an issue of a server project (server mode): the issue
 * becomes a card of the project's shared board, which every member sees, and
 * the server writes its spec. The investigation of a local project runs an
 * agent on this computer, in the project's folder, which a server project
 * does not have here.
 */
export function useServerIssueCards(
	projectId: string | undefined,
	onNavigateToTask?: (taskId: string) => void,
) {
	// The cards made here, by issue number, until the board links them itself
	const [created, setCreated] = useState<ReadonlyMap<number, string>>(new Map());
	const [creating, setCreating] = useState<number | null>(null);

	const createCard = useCallback(
		async (issue: GitHubIssue) => {
			if (!projectId || creating !== null) return;
			setCreating(issue.number);
			try {
				const result = await window.electronAPI.importGitHubIssues(projectId, [
					issue.number,
				]);
				const task = result.success ? result.data?.tasks?.[0] : undefined;
				if (!task) {
					const error =
						result.data?.errors?.[0] ?? result.error ?? "Failed to create the card";
					useIssuesStore.getState().setError(error);
					return;
				}
				useTaskStore.getState().addTask(task);
				setCreated((before) => new Map(before).set(issue.number, task.id));
				onNavigateToTask?.(task.id);
			} finally {
				setCreating(null);
			}
		},
		[projectId, creating, onNavigateToTask],
	);

	return { created, creating, createCard };
}
