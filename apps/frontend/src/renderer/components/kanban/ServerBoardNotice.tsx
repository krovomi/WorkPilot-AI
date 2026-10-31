import type { Project } from "@shared/types";
import { Server } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";

/** How often a server board is read again while it is on screen. */
export const SERVER_BOARD_REFRESH_MS = 5_000;

/** The selected project when it is a server project (server mode). */
export function useSelectedServerProject(): Project | undefined {
	return useProjectStore((state) => {
		const project = state.projects.find((p) => p.id === state.selectedProjectId);
		return project?.remote ? project : undefined;
	});
}

/**
 * Keeps a server board current while it is shown: what a teammate creates,
 * edits, starts or deletes appears within a few seconds. A read that fails
 * keeps the cards already shown.
 */
export function useServerBoardRefresh(projectId: string): void {
	useEffect(() => {
		let stopped = false;
		const timer = setInterval(async () => {
			const result = await globalThis.electronAPI.getTasks(projectId);
			const selected = useProjectStore.getState().selectedProjectId;
			if (!stopped && selected === projectId && result.success && result.data) {
				useTaskStore.getState().setTasks(result.data);
			}
		}, SERVER_BOARD_REFRESH_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [projectId]);
}

/**
 * Says the board is the server's, shared with the team, and the user's role
 * on it; keeps it current while it is shown.
 */
export function ServerBoardNotice({ project }: { readonly project: Project }) {
	const { t } = useTranslation("tasks");
	useServerBoardRefresh(project.id);
	const role = project.remote?.role ?? "viewer";
	return (
		<span
			className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground"
			title={t("kanban.serverBoardHint")}
		>
			<Server className="h-3.5 w-3.5" aria-hidden="true" />
			{t("kanban.serverBoard", { role: t(`kanban.serverRole.${role}`) })}
		</span>
	);
}
