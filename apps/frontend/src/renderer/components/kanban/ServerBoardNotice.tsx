import type { Project } from "@shared/types";
import { Server } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";

/** How often a server board is read again while its live stream is down. */
export const SERVER_BOARD_REFRESH_MS = 5_000;
/**
 * How often it is read while the stream is up: the stream says when a card
 * changes, but not each step of a build's progress.
 */
export const SERVER_BOARD_LIVE_REFRESH_MS = 15_000;

/** The selected project when it is a server project (server mode). */
export function useSelectedServerProject(): Project | undefined {
	return useProjectStore((state) => {
		const project = state.projects.find((p) => p.id === state.selectedProjectId);
		return project?.remote ? project : undefined;
	});
}

/**
 * Keeps a server board current while it is shown. The main process follows
 * the project's live stream: what a teammate creates, edits, starts or
 * deletes is read at once. The board is also read on a timer, every few
 * seconds while the stream is down and less often while it is up. A read
 * that fails keeps the cards already shown.
 */
export function useServerBoardRefresh(projectId: string): void {
	useEffect(() => {
		const api = globalThis.electronAPI;
		let stopped = false;
		let live = false;
		let reading = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const schedule = () => {
			if (timer) clearTimeout(timer);
			if (stopped) return;
			timer = setTimeout(
				read,
				live ? SERVER_BOARD_LIVE_REFRESH_MS : SERVER_BOARD_REFRESH_MS,
			);
		};
		async function read() {
			if (stopped || reading) return;
			reading = true;
			try {
				const result = await api.getTasks(projectId);
				const selected = useProjectStore.getState().selectedProjectId;
				if (!stopped && selected === projectId && result.success && result.data) {
					useTaskStore.getState().setTasks(result.data);
				}
			} catch {
				// Unreachable server: the cards already shown stay.
			} finally {
				reading = false;
				schedule();
			}
		}

		const off = api.onServerBoardLive?.((update) => {
			if (stopped || update.projectId !== projectId) return;
			live = update.live;
			if (update.changed) void read();
			else schedule();
		});
		void api.watchServerBoard?.(projectId);
		schedule();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			off?.();
			void api.unwatchServerBoard?.(projectId);
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
