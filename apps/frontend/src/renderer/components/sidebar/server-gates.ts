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
	// Read from the server's runs, jobs and ledgers (main/server-workspace.ts)
	"dashboard",
	"analytics",
	"cost-estimator",
	"session-history",
	"roadmap",
	"ideation",
	"insights",
	"context",
	"github-issues",
	"github-prs",
	"gitlab-issues",
	"gitlab-merge-requests",
	// Analyses run on the server, their last report shared (`server-analyses.ts`).
	"accessibility-agent",
	"i18n-agent",
	"doc-drift",
	"flaky-tests",
	"tech-debt",
	"administration",
]);

/** The forge a server project's issue and review views go through. */
export type ServerForge = "github" | "gitlab";

const GITHUB_URL =
	/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/;

/**
 * The forge whose views a server project offers, as the server lists it (a
 * GitLab one only on an instance its operator named): its issues and pull or
 * merge requests go through the server with the person's own token
 * (`ipc-handlers/github/server-relay.ts`, `ipc-handlers/gitlab/server-relay.ts`).
 * A server that does not list it yet: GitHub, read from the clone URL.
 */
export function serverForge(project: Project | undefined): ServerForge | null {
	const remote = project?.remote;
	if (!remote) return null;
	if (remote.forge !== undefined) return remote.forge;
	return GITHUB_URL.test((remote.repoUrl ?? "").trim()) ? "github" : null;
}

const ADMIN_PERMISSIONS = [
	"org.member.read",
	"org.role.read",
	"org.quota.read",
	"audit.read",
];

const FORGE_VIEWS: Readonly<Record<ServerForge, ReadonlySet<SidebarView>>> = {
	github: new Set<SidebarView>(["github-issues", "github-prs"]),
	gitlab: new Set<SidebarView>(["gitlab-issues", "gitlab-merge-requests"]),
};

/**
 * Whether the sidebar shows this view for the selected project; a server
 * project's GitHub or GitLab views only when it is on that forge
 * ({@link serverForge}).
 */
export function showsView(
	view: SidebarView,
	serverProject: boolean,
	forge: ServerForge | null = null,
): boolean {
	if (!serverProject) return true;
	for (const [name, views] of Object.entries(FORGE_VIEWS)) {
		if (views.has(view)) return forge === name;
	}
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
