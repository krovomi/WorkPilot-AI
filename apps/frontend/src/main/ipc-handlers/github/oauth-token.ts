/**
 * The token of a GitHub sign-in through the gh CLI, saved from the main
 * process. The renderer only ever holds MASKED_SECRET for it (rule S6,
 * `GITHUB_GET_TOKEN`); when it saves the project settings with the OAuth
 * method and that mask, the token written to `.workpilot/.env` is the one gh
 * holds now, read here.
 */
import type { ProjectEnvConfig } from "../../../shared/types";
import { unmaskSecret } from "../../utils/masked-secret";
import { getGitHubTokenForSubprocess } from "./utils";

/**
 * `update` (the renderer's settings with masks dropped) with gh's token when
 * `sent` asked for the OAuth token by its mask. A token typed by hand, or a
 * mask without the OAuth method, is left as it was.
 */
export async function withGhCliToken(
	sent: Partial<ProjectEnvConfig>,
	update: Partial<ProjectEnvConfig>,
): Promise<Partial<ProjectEnvConfig>> {
	if (sent.githubAuthMethod !== "oauth") return update;
	if (typeof sent.githubToken !== "string") return update;
	if (unmaskSecret(sent.githubToken) !== undefined) return update;
	const token = await getGitHubTokenForSubprocess();
	return token ? { ...update, githubToken: token } : update;
}
