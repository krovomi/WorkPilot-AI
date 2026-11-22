/**
 * Where a project's memory lifecycle is served: this machine's backend for a
 * local project (`/api/brain/memory/*`, the person's brain, named by the
 * project's path), the WorkPilot server for a server project
 * (`/api/features/context/memory/*`, the project's own brain, named by its
 * id; the server checks the permission and never takes a path).
 *
 * Both answer the same shape (`{ success, ... }`), so a handler reads one.
 * The renderer only ever names the project by id: the path or the server
 * project is the main process's own.
 */

import type { Project } from "../../../shared/types";
import { type BackendResult, backendFetch } from "../_backend-fetch";
import { authedFetch } from "../../server-connection";
import { featureProject } from "../server-feature-files";

export type MemoryTarget =
	| { kind: "local"; path: string }
	| { kind: "server"; project: Project };

/** The routes a server project serves; the conflict queue stays on the desktop. */
export type ServerMemoryRoute =
	| "/lifecycle"
	| "/history"
	| "/forget"
	| "/restore"
	| "/pin"
	| "/scope"
	| "/revert";

type Fields = Record<string, string | number | boolean | string[]>;

/** The project behind an id, or why there is none. */
export function memoryTarget(projectId: unknown): MemoryTarget | { error: string } {
	const project = featureProject(projectId);
	if (!project) return { error: "project-not-found" };
	return project.remote ? { kind: "server", project } : { kind: "local", path: project.path };
}

/** A local project's path; a server project has no conflict queue to act on. */
export function localOnly(projectId: unknown): { path: string } | { error: string } {
	const target = memoryTarget(projectId);
	if ("error" in target) return target;
	return target.kind === "local" ? { path: target.path } : { error: "server-project" };
}

function query(fields: Fields): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) params.set(key, String(value));
	return params.toString();
}

async function serverFetch<T>(
	project: Project,
	route: ServerMemoryRoute,
	method: "GET" | "POST",
	fields: Fields,
): Promise<BackendResult<T>> {
	const id = { project_id: project.id };
	const path = `/api/features/context/memory${route}`;
	const answer =
		method === "GET"
			? await authedFetch<unknown>(`${path}?${query({ ...id, ...fields })}`, "GET")
			: await authedFetch<unknown>(`${path}?${query(id)}`, "POST", fields);
	if (!answer.ok) return { success: false, error: answer.error };
	const data = answer.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { success: false, error: "invalid-answer" };
	}
	const body = data as { success?: unknown; error?: unknown };
	if (body.success === true) return data as BackendResult<T>;
	return {
		...(data as object),
		success: false,
		error: typeof body.error === "string" ? body.error : "failed",
	};
}

/** One lifecycle call, on this machine or on the server. */
export function memoryFetch<T>(
	target: MemoryTarget,
	route: ServerMemoryRoute,
	method: "GET" | "POST",
	fields: Fields,
	timeoutMs?: number,
): Promise<BackendResult<T>> {
	if (target.kind === "server") return serverFetch<T>(target.project, route, method, fields);
	const path = `/api/brain/memory${route}`;
	const local = { project_dir: target.path, ...fields };
	return method === "GET"
		? backendFetch<T>(`${path}?${query(local)}`, { method: "GET" }, timeoutMs)
		: // No headers: backendFetch sets the JSON content type itself.
			backendFetch<T>(path, { method: "POST", body: JSON.stringify(local) }, timeoutMs);
}
