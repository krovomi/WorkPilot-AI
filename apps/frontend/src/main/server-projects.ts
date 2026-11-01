/**
 * Server projects (server mode): the projects of the WorkPilot server the app
 * is signed in to, shown next to the projects of this computer.
 *
 * A server project is never added to the local project store: every local
 * handler that looks a project up by id finds nothing and refuses, so nothing
 * runs on this computer against it. Its `path` is the app's read-only mirror
 * of the board (`remote-board.ts`), under the app's data folder; the server
 * decides who sees, creates and deletes a project.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { DEFAULT_PROJECT_SETTINGS } from "../shared/constants";
import type {
	IPCResult,
	Project,
	RemoteProjectInfo,
} from "../shared/types";
import { authedFetch, getServerUrl, isServerMode } from "./server-connection";

/** A server project id: a UUID, which also makes a safe folder name. */
const SERVER_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ROLES = new Set<RemoteProjectInfo["role"]>(["viewer", "member", "owner"]);
const MAX_NAME = 200;
const MAX_REPO_URL = 2000;
const MAX_BRANCH = 255;

let known = new Map<string, Project>();

/** Where the board of a server project is mirrored, per server. */
export function mirrorDirFor(serverUrl: string, projectId: string): string {
	const server = createHash("sha256").update(serverUrl).digest("hex").slice(0, 16);
	return path.join(app.getPath("userData"), "server-boards", server, projectId);
}

function text(value: unknown, max: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max
		? value
		: null;
}

const FORGES = new Set(["github", "gitlab"]);

/**
 * The forge the server lists for a project, whose views the app shows; none
 * when the server does not list one (a server older than the field).
 */
function forgeOf(value: unknown): Pick<RemoteProjectInfo, "forge"> {
	if (value === null) return { forge: null };
	return typeof value === "string" && FORGES.has(value)
		? { forge: value as "github" | "gitlab" }
		: {};
}

/** A `/projects` entry as an app project, or null when it is not one. */
export function toProject(raw: unknown, serverUrl: string): Project | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const id = typeof item.id === "string" ? item.id : "";
	const name = text(item.name, MAX_NAME);
	const repoUrl = text(item.repo_url, MAX_REPO_URL);
	if (!SERVER_PROJECT_ID.test(id) || !name || !repoUrl) return null;
	const defaultBranch = text(item.default_branch, MAX_BRANCH) ?? "main";
	// No role means an organization admin listing a project they are not a
	// member of: what they may do is the server's call, the app shows it read-only.
	const role = ROLES.has(item.my_role as RemoteProjectInfo["role"])
		? (item.my_role as RemoteProjectInfo["role"])
		: "viewer";
	const created = new Date(typeof item.created_at === "string" ? item.created_at : 0);
	return {
		id,
		name,
		path: mirrorDirFor(serverUrl, id),
		autoBuildPath: ".workpilot",
		settings: { ...DEFAULT_PROJECT_SETTINGS, mainBranch: defaultBranch },
		createdAt: created,
		updatedAt: created,
		remote: { repoUrl, defaultBranch, role, ...forgeOf(item.forge) },
	};
}

/**
 * The server projects the signed-in user sees in the organization they act
 * in; none in local mode. A failed listing keeps the last one, so a network
 * blip does not empty the tabs.
 */
export async function listServerProjects(): Promise<Project[]> {
	const serverUrl = getServerUrl();
	if (!isServerMode() || !serverUrl) {
		known = new Map();
		return [];
	}
	const result = await authedFetch<unknown>("/projects", "GET");
	if (!result.ok || !Array.isArray(result.data)) return [...known.values()];
	const next = new Map<string, Project>();
	for (const raw of result.data) {
		const project = toProject(raw, serverUrl);
		if (project) next.set(project.id, project);
	}
	known = next;
	return [...known.values()];
}

/** The server project with this id, as last listed; undefined otherwise. */
export function getServerProject(projectId: unknown): Project | undefined {
	return typeof projectId === "string" ? known.get(projectId) : undefined;
}

/**
 * The server project whose mirror is this folder, for a view that names its
 * project by path; undefined for any other folder.
 */
export function serverProjectAtPath(projectPath: unknown): Project | undefined {
	if (typeof projectPath !== "string" || !projectPath) return undefined;
	const wanted = path.resolve(projectPath);
	for (const project of known.values()) {
		if (path.resolve(project.path) === wanted) return project;
	}
	return undefined;
}

/** Register a repository on the server, which clones it for the whole team. */
export async function createServerProject(
	input: unknown,
): Promise<IPCResult<Project>> {
	const serverUrl = getServerUrl();
	if (!isServerMode() || !serverUrl) {
		return { success: false, error: "Not connected to a WorkPilot server" };
	}
	const body = (input && typeof input === "object" ? input : {}) as Record<
		string,
		unknown
	>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";
	const branch =
		typeof body.defaultBranch === "string" ? body.defaultBranch.trim() : "";
	if (!name || name.length > MAX_NAME) {
		return { success: false, error: "A project name is required" };
	}
	if (!repoUrl || repoUrl.length > MAX_REPO_URL || /\s/.test(repoUrl)) {
		return { success: false, error: "A repository URL is required" };
	}
	if (branch.length > MAX_BRANCH || /\s/.test(branch)) {
		return { success: false, error: "Invalid branch name" };
	}
	const result = await authedFetch<unknown>("/projects", "POST", {
		name,
		repo_url: repoUrl,
		default_branch: branch || "main",
	});
	if (!result.ok) return { success: false, error: result.error };
	const project = toProject(result.data, serverUrl);
	if (!project) return { success: false, error: "Unexpected server answer" };
	known.set(project.id, project);
	return { success: true, data: project };
}

/** Delete a server project for everyone (its owner only, the server checks). */
export async function deleteServerProject(projectId: unknown): Promise<IPCResult> {
	const project = getServerProject(projectId);
	if (!project) return { success: false, error: "Unknown server project" };
	const result = await authedFetch<unknown>(
		`/projects/${encodeURIComponent(project.id)}`,
		"DELETE",
	);
	if (!result.ok) return { success: false, error: result.error };
	known.delete(project.id);
	rmSync(project.path, { recursive: true, force: true });
	return { success: true };
}
