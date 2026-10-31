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
	"insights",
	"context",
	"github-issues",
	"github-prs",
	"administration",
]);

const GITHUB_URL =
	/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/;

/**
 * The forge whose views a server project offers, read from the URL it was
 * cloned from: its GitHub issues and pull requests go through the server
 * with the person's own token (`ipc-handlers/github/server-relay.ts`).
 */
export function serverForge(project: Project | undefined): "github" | null {
	return GITHUB_URL.test((project?.remote?.repoUrl ?? "").trim()) ? "github" : null;
}

const ADMIN_PERMISSIONS = [
	"org.member.read",
	"org.role.read",
	"org.quota.read",
	"audit.read",
];

const GITHUB_VIEWS: ReadonlySet<SidebarView> = new Set<SidebarView>([
	"github-issues",
	"github-prs",
]);

/**
 * Whether the sidebar shows this view for the selected project; a server
 * project's GitHub views only when it is on GitHub ({@link serverForge}).
 */
export function showsView(
	view: SidebarView,
	serverProject: boolean,
	forge: "github" | null = null,
): boolean {
	if (!serverProject) return true;
	if (GITHUB_VIEWS.has(view)) return forge === "github";
	return SERVER_PROJECT_VIEWS.has(view);
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
	const forge = serverForge(project);
	useEffect(() => {
		if (!showsView(activeView, serverProject, forge)) onViewChange?.("kanban");
	}, [activeView, serverProject, forge, onViewChange]);
	return { canAdminister: isServerMode && hasAdminPermission, serverProject };
}
