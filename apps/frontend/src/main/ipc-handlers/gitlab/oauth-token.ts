/**
 * The token of a GitLab sign-in through the glab CLI, saved from the main
 * process, as `github/oauth-token.ts` does for gh. The renderer only ever
 * holds MASKED_SECRET for it (rule S6, `GITLAB_GET_TOKEN`); when it saves the
 * project settings with the OAuth method and that mask, the token written to
 * `.workpilot/.env` is the one glab holds now for the settings' instance.
 */
import type { ProjectEnvConfig } from "../../../shared/types";
import { unmaskSecret } from "../../utils/masked-secret";
import { getGlabToken, glabHost } from "./utils";

/**
 * `update` (the renderer's settings with masks dropped) with glab's token
 * when `sent` asked for the OAuth token by its mask. A token typed by hand, a
 * mask without the OAuth method or an instance glab cannot name is left as it
 * was.
 */
export async function withGlabCliToken(
	sent: Partial<ProjectEnvConfig>,
	update: Partial<ProjectEnvConfig>,
): Promise<Partial<ProjectEnvConfig>> {
	if (sent.gitlabAuthMethod !== "oauth") return update;
	if (typeof sent.gitlabToken !== "string") return update;
	if (unmaskSecret(sent.gitlabToken) !== undefined) return update;
	const host = glabHost(sent.gitlabInstanceUrl);
	const token = host ? await getGlabToken(host) : null;
	return token ? { ...update, gitlabToken: token } : update;
}
