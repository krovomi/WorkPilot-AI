/**
 * The person's own integration tokens on the server (server mode): a GitHub
 * or GitLab token, a Jira or Linear key, an Azure DevOps PAT. The server keeps
 * them encrypted (`apps/backend/server/services/secrets.py`) and gives each
 * one to the runs that person starts, so what a run does on a forge or a
 * tracker is done as them, not as the deployment.
 *
 * A token goes one way: set or removed from here, never read back. The server
 * says only which kinds are set, and nothing here returns a value to the
 * renderer. The kind is one of a closed list, checked again here.
 */

import type { IPCResult } from "../shared/types";
import { authedFetch } from "./server-connection";

/** As the server allows them (`SECRET_KINDS`). */
export const SERVER_SECRET_KINDS = [
	"github_token",
	"gitlab_token",
	"jira_token",
	"linear_api_key",
	"azure_pat",
] as const;
export type ServerSecretKind = (typeof SERVER_SECRET_KINDS)[number];

const MAX_SECRET = 4_096;
const KINDS: ReadonlySet<string> = new Set(SERVER_SECRET_KINDS);

function isKind(kind: unknown): kind is ServerSecretKind {
	return typeof kind === "string" && KINDS.has(kind);
}

/**
 * The server's reason, or a plain one: a refusal is shown to the person, and
 * a validation error could quote what was sent.
 */
function reason(error: unknown, fallback: string): string {
	return typeof error === "string" && error.length <= 300 ? error : fallback;
}

/** Which of the person's tokens the server holds. */
export async function listServerSecrets(): Promise<IPCResult<ServerSecretKind[]>> {
	const result = await authedFetch<{ kinds?: unknown }>("/users/me/secrets", "GET");
	if (!result.ok) {
		return { success: false, error: reason(result.error, "Server unavailable") };
	}
	const kinds = Array.isArray(result.data?.kinds) ? result.data.kinds : [];
	return { success: true, data: kinds.filter(isKind) };
}

/** Store or replace one of the person's tokens. */
export async function setServerSecret(
	kind: unknown,
	value: unknown,
): Promise<IPCResult> {
	if (!isKind(kind)) return { success: false, error: "Unknown token" };
	const token = typeof value === "string" ? value.trim() : "";
	if (!token || token.length > MAX_SECRET || /\s/.test(token)) {
		return { success: false, error: "Invalid token" };
	}
	const result = await authedFetch("/users/me/secrets", "PUT", {
		kind,
		value: token,
	});
	return result.ok
		? { success: true }
		: { success: false, error: reason(result.error, "The server refused the token") };
}

/** Remove one of the person's tokens from the server. */
export async function deleteServerSecret(kind: unknown): Promise<IPCResult> {
	if (!isKind(kind)) return { success: false, error: "Unknown token" };
	const result = await authedFetch(
		`/users/me/secrets/${encodeURIComponent(kind)}`,
		"DELETE",
	);
	return result.ok
		? { success: true }
		: { success: false, error: reason(result.error, "Server unavailable") };
}
