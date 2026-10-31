import type { Project } from "@shared/types";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";

/** The selected project when it is a server project (server mode). */
export function useSelectedServerProject(): Project | undefined {
	return useProjectStore((state) => {
		const project = state.projects.find((p) => p.id === state.selectedProjectId);
		return project?.remote ? project : undefined;
	});
}

/**
 * Says the board is the server's, shared with the team, and the user's role
 * on it. Card actions from the app are not wired yet: they still refuse.
 */
export function ServerBoardNotice({ project }: { readonly project: Project }) {
	const { t } = useTranslation("tasks");
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
