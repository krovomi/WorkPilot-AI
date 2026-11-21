/**
 * The MCP Builder projects the main keeps for the renderer, checked before
 * they are written or read back: known fields only, each with its type and a
 * size limit, and an id that stays a short plain token.
 */
import { z } from "zod";
import type { McpBuilderProject } from "../../shared/types/mcp-marketplace";

const MAX_PROJECTS = 200;
const MAX_TOOLS = 100;
const MAX_ITEMS = 50;
const MAX_LABEL = 200;
const MAX_TEXT = 4 * 1024;
const MAX_URL = 8 * 1024;
const MAX_TEMPLATE = 64 * 1024;

/** The ids the builder makes (`<time>-<random>`), or any short plain token. */
export const builderId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const label = z.string().max(MAX_LABEL);
const text = z.string().max(MAX_TEXT);

const headers = z
	.record(z.string().max(MAX_LABEL), z.string().max(MAX_TEXT))
	.refine((value) => Object.keys(value).length <= MAX_ITEMS);

const envVar = z.object({
	name: label,
	label,
	description: text,
	required: z.boolean(),
	placeholder: text.optional(),
	secret: z.boolean(),
	helpUrl: z.string().max(MAX_URL).optional(),
});

const param = z.object({
	name: label,
	type: z.enum(["string", "number", "boolean", "array", "object"]),
	description: text,
	required: z.boolean(),
	defaultValue: text.optional(),
});

const action = z.object({
	type: z.enum(["http_request", "transform", "chain"]),
	http: z
		.object({
			method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
			url: z.string().max(MAX_URL),
			headers: headers.optional(),
			bodyTemplate: z.string().max(MAX_TEMPLATE).optional(),
		})
		.optional(),
	transform: z.object({ template: z.string().max(MAX_TEMPLATE) }).optional(),
	chain: z.object({ steps: z.array(builderId).max(MAX_ITEMS) }).optional(),
});

const tool = z.object({
	id: builderId,
	name: label,
	description: text,
	parameters: z.array(param).max(MAX_ITEMS),
	action,
});

const project = z.object({
	id: builderId,
	name: label,
	description: text,
	icon: z.string().max(64),
	color: z.string().max(32),
	baseUrl: z.string().max(MAX_URL).optional(),
	defaultHeaders: headers.optional(),
	envVars: z.array(envVar).max(MAX_ITEMS),
	tools: z.array(tool).max(MAX_TOOLS),
	createdAt: z.string().max(64),
	updatedAt: z.string().max(64),
});

/** The project the renderer sends, with unknown fields dropped; null if invalid. */
export function parseBuilderProject(value: unknown): McpBuilderProject | null {
	const parsed = project.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** The id of a project to delete; null if it is not one the builder makes. */
export function parseBuilderId(value: unknown): string | null {
	const id = (value as { projectId?: unknown } | null)?.projectId;
	const parsed = builderId.safeParse(id);
	return parsed.success ? parsed.data : null;
}

/** The valid projects of what was read from disk, at most MAX_PROJECTS. */
export function validBuilderProjects(value: unknown): McpBuilderProject[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(parseBuilderProject)
		.filter((entry): entry is McpBuilderProject => entry !== null)
		.slice(0, MAX_PROJECTS);
}

/** Whether one more project can be kept. */
export function hasRoomForProject(count: number): boolean {
	return count < MAX_PROJECTS;
}
