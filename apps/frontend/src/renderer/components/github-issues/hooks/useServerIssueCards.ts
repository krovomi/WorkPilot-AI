import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useIssuesStore } from "../../../stores/github/issues-store";
import { useGitLabStore } from "../../../stores/gitlab-store";
import { useTaskStore } from "../../../stores/task-store";

/** How "Create Task" reaches the issues of each forge, and shows a refusal. */
const FORGES = {
	github: {
		importIssues: (projectId: string, numbers: number[]) =>
			window.electronAPI.importGitHubIssues(projectId, numbers),
		showError: (error: string) => useIssuesStore.getState().setError(error),
		failedKey: "common:githubIssues.createCardFailed",
	},
	gitlab: {
		importIssues: (projectId: string, numbers: number[]) =>
			window.electronAPI.importGitLabIssues(projectId, numbers),
		showError: (error: string) => useGitLabStore.getState().setError(error),
		failedKey: "gitlab:errors.createCard",
	},
} as const;

/**
 * "Create Task" on an issue of a server project (server mode): the issue
 * becomes a card of the project's shared board, which every member sees, and
 * the server writes its spec. The investigation of a local project runs an
 * agent on this computer, in the project's folder, which a server project
 * does not have here. `issueNumber` is the GitHub number or the GitLab iid.
 */
export function useServerIssueCards(
	projectId: string | undefined,
	onNavigateToTask?: (taskId: string) => void,
	forge: keyof typeof FORGES = "github",
) {
	const { t } = useTranslation(["common", "gitlab"]);
	// The cards made here, by issue number, until the board links them itself
	const [created, setCreated] = useState<ReadonlyMap<number, string>>(new Map());
	const [creating, setCreating] = useState<number | null>(null);

	const createCard = useCallback(
		async (issueNumber: number) => {
			if (!projectId || creating !== null) return;
			const { importIssues, showError, failedKey } = FORGES[forge];
			setCreating(issueNumber);
			try {
				const result = await importIssues(projectId, [issueNumber]);
				const task = result.success ? result.data?.tasks?.[0] : undefined;
				if (!task) {
					showError(result.data?.errors?.[0] ?? result.error ?? t(failedKey));
					return;
				}
				useTaskStore.getState().addTask(task);
				setCreated((before) => new Map(before).set(issueNumber, task.id));
				onNavigateToTask?.(task.id);
			} catch {
				// A call that throws is a failure too, not an unhandled rejection.
				showError(t(failedKey));
			} finally {
				setCreating(null);
			}
		},
		[projectId, creating, onNavigateToTask, forge, t],
	);

	return { created, creating, createCard };
}
