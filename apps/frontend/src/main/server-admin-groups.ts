/**
 * Groups of people in the organization the user administers (server mode).
 *
 * A group gives its members an organization role and a role on chosen
 * projects, on top of their own. The server decides who may manage groups;
 * this module only refuses arguments that are not what they claim to be (an
 * id that is not an id, a role that is not a project role) before they are
 * put in a URL, since the renderer that sends them is not trusted.
 */

import { authedFetch } from "./server-connection";

export interface GroupMemberSummary {
	user_id: string;
	email: string;
	display_name: string;
}

export interface GroupProjectSummary {
	project_id: string;
	name: string;
	role: string;
}

export interface GroupSummary {
	id: string;
	name: string;
	description: string;
	role_slug: string | null;
	role_name: string | null;
	members: GroupMemberSummary[];
	projects: GroupProjectSummary[];
	created_at: string;
}

export interface GroupProjectOption {
	id: string;
	name: string;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** A server id (UUID-shaped): also safe to put in a URL path. */
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ROLE_SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PROJECT_ROLES = new Set(["viewer", "member", "owner"]);
const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;

function bad(error: string): Result<never> {
	return { ok: false, error };
}

function isId(value: unknown): value is string {
	return typeof value === "string" && ID.test(value);
}

function groupPath(groupId: string, ...rest: string[]): string {
	return `/admin/groups/${[groupId, ...rest].map(encodeURIComponent).join("/")}`;
}

/** The fields of a create or update request, or an error naming the bad one. */
function groupBody(
	input: unknown,
	partial: boolean,
): Result<{ name?: string; description?: string; role_slug?: string }> {
	const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const body: { name?: string; description?: string; role_slug?: string } = {};
	if (raw.name !== undefined || !partial) {
		const name = typeof raw.name === "string" ? raw.name.trim() : "";
		if (!name || name.length > MAX_NAME) return bad("A group name is required");
		body.name = name;
	}
	if (raw.description !== undefined) {
		if (typeof raw.description !== "string" || raw.description.length > MAX_DESCRIPTION) {
			return bad("Invalid description");
		}
		body.description = raw.description;
	}
	if (raw.role_slug !== undefined && raw.role_slug !== null) {
		// "" removes the group's organization role on an update.
		if (typeof raw.role_slug !== "string") return bad("Invalid role");
		if (raw.role_slug !== "" && !ROLE_SLUG.test(raw.role_slug)) return bad("Invalid role");
		if (raw.role_slug !== "" || partial) body.role_slug = raw.role_slug;
	}
	return { ok: true, data: body };
}

export const groupsApi = {
	list: () => authedFetch<GroupSummary[]>("/admin/groups", "GET"),

	/** The projects a group can be given a role on: those the user sees. */
	async projects(): Promise<Result<GroupProjectOption[]>> {
		const result = await authedFetch<unknown>("/projects", "GET");
		if (!result.ok) return result;
		if (!Array.isArray(result.data)) return bad("Unexpected answer from the server");
		const options: GroupProjectOption[] = [];
		for (const raw of result.data) {
			const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
			if (isId(item.id) && typeof item.name === "string" && item.name) {
				options.push({ id: item.id, name: item.name.slice(0, 200) });
			}
		}
		return { ok: true, data: options };
	},

	create(input: unknown): Promise<Result<GroupSummary>> {
		const body = groupBody(input, false);
		if (!body.ok) return Promise.resolve(body);
		return authedFetch<GroupSummary>("/admin/groups", "POST", body.data);
	},

	update(groupId: unknown, input: unknown): Promise<Result<GroupSummary>> {
		if (!isId(groupId)) return Promise.resolve(bad("Invalid group"));
		const body = groupBody(input, true);
		if (!body.ok) return Promise.resolve(body);
		return authedFetch<GroupSummary>(groupPath(groupId), "PATCH", body.data);
	},

	remove(groupId: unknown): Promise<Result<{ deleted: boolean }>> {
		if (!isId(groupId)) return Promise.resolve(bad("Invalid group"));
		return authedFetch<{ deleted: boolean }>(groupPath(groupId), "DELETE");
	},

	setMember(
		groupId: unknown,
		userId: unknown,
		inGroup: unknown,
	): Promise<Result<GroupSummary>> {
		if (!isId(groupId) || !isId(userId) || typeof inGroup !== "boolean") {
			return Promise.resolve(bad("Invalid group member"));
		}
		return authedFetch<GroupSummary>(
			groupPath(groupId, "members", userId),
			inGroup ? "PUT" : "DELETE",
		);
	},

	/** Give the group a role on a project; a null role takes the project away. */
	setProjectRole(
		groupId: unknown,
		projectId: unknown,
		role: unknown,
	): Promise<Result<GroupSummary>> {
		if (!isId(groupId) || !isId(projectId)) {
			return Promise.resolve(bad("Invalid group project"));
		}
		if (role === null) {
			return authedFetch<GroupSummary>(groupPath(groupId, "projects", projectId), "DELETE");
		}
		if (typeof role !== "string" || !PROJECT_ROLES.has(role)) {
			return Promise.resolve(bad("Invalid project role"));
		}
		return authedFetch<GroupSummary>(groupPath(groupId, "projects", projectId), "PUT", {
			role,
		});
	},
};
