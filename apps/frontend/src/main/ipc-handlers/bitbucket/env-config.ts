/**
 * The Bitbucket Cloud keys of a project's `.workpilot/.env`, read into and
 * written from `ProjectEnvConfig` for `env-handlers.ts`. BITBUCKET_TOKEN is
 * stored `enc:` (`project-env-secrets.json`) and masked before the renderer
 * sees it (`PROJECT_ENV_SECRET_FIELDS`). A repository typed as
 * `workspace/repo` or a clone URL is written as its two slugs.
 */

import type { ProjectEnvConfig } from "../../../shared/types";
import { normalizeBitbucketRepo } from "../../../shared/utils/bitbucket-repo";

export const BITBUCKET_ENV_KEYS = {
	ENABLED: "BITBUCKET_ENABLED",
	WORKSPACE: "BITBUCKET_WORKSPACE",
	REPO: "BITBUCKET_REPO",
	USERNAME: "BITBUCKET_USERNAME",
	TOKEN: "BITBUCKET_TOKEN",
	AUTO_SYNC: "BITBUCKET_AUTO_SYNC",
} as const;

type BitbucketFields = Pick<
	ProjectEnvConfig,
	| "bitbucketEnabled"
	| "bitbucketWorkspace"
	| "bitbucketRepo"
	| "bitbucketUsername"
	| "bitbucketToken"
	| "bitbucketAutoSync"
>;

const flag = (value: boolean) => (value ? "true" : "false");

/** A text field: an empty value never overwrites a stored one (as for the other forges). */
function setText(vars: Record<string, string>, key: string, value: string | undefined): void {
	if (value === undefined) return;
	if (value || !vars[key]) vars[key] = value;
}

/** Applies the Bitbucket fields of an update to the file's variables. */
export function applyBitbucketEnvUpdate(
	vars: Record<string, string>,
	config: Partial<ProjectEnvConfig>,
): void {
	const K = BITBUCKET_ENV_KEYS;
	if (config.bitbucketEnabled !== undefined) vars[K.ENABLED] = flag(config.bitbucketEnabled);
	const ref = normalizeBitbucketRepo(
		config.bitbucketWorkspace ?? vars[K.WORKSPACE],
		config.bitbucketRepo,
	);
	if (ref) {
		vars[K.WORKSPACE] = ref.workspace;
		vars[K.REPO] = ref.repo;
	} else {
		setText(vars, K.WORKSPACE, config.bitbucketWorkspace);
		setText(vars, K.REPO, config.bitbucketRepo);
	}
	setText(vars, K.USERNAME, config.bitbucketUsername);
	setText(vars, K.TOKEN, config.bitbucketToken);
	if (config.bitbucketAutoSync !== undefined) vars[K.AUTO_SYNC] = flag(config.bitbucketAutoSync);
}

/** The Bitbucket fields of a project's config; explicit BITBUCKET_ENABLED wins over a set token. */
export function readBitbucketEnvConfig(vars: Record<string, string>): BitbucketFields {
	const K = BITBUCKET_ENV_KEYS;
	const enabled = vars[K.ENABLED];
	const fields: BitbucketFields = {
		bitbucketEnabled:
			enabled !== undefined ? enabled.toLowerCase() === "true" : Boolean(vars[K.TOKEN]),
		bitbucketAutoSync: vars[K.AUTO_SYNC]?.toLowerCase() === "true",
	};
	if (vars[K.WORKSPACE]) fields.bitbucketWorkspace = vars[K.WORKSPACE];
	if (vars[K.REPO]) fields.bitbucketRepo = vars[K.REPO];
	if (vars[K.USERNAME]) fields.bitbucketUsername = vars[K.USERNAME];
	if (vars[K.TOKEN]) fields.bitbucketToken = vars[K.TOKEN];
	return fields;
}

const line = (vars: Record<string, string>, key: string, example = "") =>
	vars[key] ? `${key}=${vars[key]}` : `# ${key}=${example}`;

/** The Bitbucket section of the generated `.env`. */
export function bitbucketEnvSection(vars: Record<string, string>): string {
	const K = BITBUCKET_ENV_KEYS;
	return [
		"# =============================================================================",
		"# BITBUCKET CLOUD INTEGRATION (OPTIONAL)",
		"# Username + API token (or app password): HTTP Basic. No username: access token (Bearer).",
		"# =============================================================================",
		line(vars, K.ENABLED, "false"),
		line(vars, K.WORKSPACE, "my-workspace"),
		line(vars, K.REPO, "my-repo"),
		line(vars, K.USERNAME),
		line(vars, K.TOKEN),
		line(vars, K.AUTO_SYNC, "false"),
	].join("\n");
}
