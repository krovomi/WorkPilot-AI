/**
 * The environment of a child process that runs someone else's code.
 *
 * WorkPilot's main process carries credentials in `process.env`: the ones a
 * profile or the development `.env-files/.env` put there, and whatever the
 * shell that launched the app exported. A project's dev server, a mobile build
 * or a local model server needs none of them, so they are left out
 * (docs/rules/security.md, S1 and S4: a secret only goes to the process that
 * needs it). Processes that talk to a provider keep building their own env.
 */
import projectEnvSecrets from "../../shared/constants/project-env-secrets.json";

const NAMED: ReadonlySet<string> = new Set([
	...projectEnvSecrets.encrypted,
	...projectEnvSecrets.readable,
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CONFIG_DIR",
	"SENTRY_DSN",
]);

// Names that say "credential" whatever the service: FOO_API_KEY, GH_TOKEN,
// DB_PASSWORD, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, X_PAT…
const SHAPED =
	/(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|DSN)(_|$)/i;

export function isCredentialName(name: string): boolean {
	return NAMED.has(name.toUpperCase()) || SHAPED.test(name);
}

export function envWithoutCredentials(
	base: NodeJS.ProcessEnv = process.env,
	extra: Record<string, string | undefined> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== undefined && !isCredentialName(name)) env[name] = value;
	}
	for (const [name, value] of Object.entries(extra)) {
		if (value !== undefined) env[name] = value;
	}
	return env;
}
