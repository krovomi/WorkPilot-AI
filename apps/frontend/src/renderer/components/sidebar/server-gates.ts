import type { Project } from "@shared/types";
import { useEffect } from "react";
import { useAnyPermission } from "@/stores/permissions-store";
import { useServerSessionStore } from "@/stores/server-session-store";
import type { SidebarView } from "../Sidebar";

/**
 * The views a server project offers (server mode). Its board and its shared
 * features are the server's and their agents run there; a view that reads or
 * runs things on this computer would act on the app's mirror, so it stays
 * hidden until the view works through the server
 * (`docs/architecture/server-mode.md`).
 */
export const SERVER_PROJECT_VIEWS: ReadonlySet<SidebarView> = new Set<SidebarView>([
	"kanban",
	"roadmap",
	"ideation",
	"administration",
]);

const ADMIN_PERMISSIONS = [
	"org.member.read",
	"org.role.read",
	"org.quota.read",
	"audit.read",
];

/** Whether the sidebar shows this view for the selected project. */
export function showsView(view: SidebarView, serverProject: boolean): boolean {
	return !serverProject || SERVER_PROJECT_VIEWS.has(view);
}

/**
 * What server mode changes in the sidebar. The administration console shows
 * only in server mode, to someone holding an administration permission
 * (`useAnyPermission` is true in local mode, hence the mode check). A server
 * project shows only {@link SERVER_PROJECT_VIEWS}, and opening one leaves a
 * view it does not offer for its board.
 */
export function useServerNavGates(
	project: Project | undefined,
	activeView: SidebarView,
	onViewChange?: (view: SidebarView) => void,
): { canAdminister: boolean; serverProject: boolean } {
	const isServerMode = useServerSessionStore((state) => state.mode) === "server";
	const hasAdminPermission = useAnyPermission(ADMIN_PERMISSIONS);
	const serverProject = Boolean(project?.remote);
	useEffect(() => {
		if (!showsView(activeView, serverProject)) onViewChange?.("kanban");
	}, [activeView, serverProject, onViewChange]);
	return { canAdminister: isServerMode && hasAdminPermission, serverProject };
}
