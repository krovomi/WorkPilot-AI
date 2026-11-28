/**
 * How each coding-agent CLI keeps a sign-in of its own: the folder variable
 * it reads, the command that signs in, and the file that proves it did.
 *
 * - GitHub CLI (Copilot): `GH_CONFIG_DIR`, `gh auth login`, `hosts.yml`. The
 *   backend's Copilot client reads the folder from `COPILOT_GH_CONFIG_DIR`, so
 *   the `gh` the agent runs for pull requests keeps the person's own login.
 * - Codex CLI (ChatGPT plan): `CODEX_HOME`, `codex login`, `auth.json`.
 * - Gemini CLI: `GEMINI_CLI_HOME` (it writes `.gemini/` inside), `gemini`,
 *   `.gemini/oauth_creds.json`.
 *
 * The commands are fixed here: the renderer never names one (rule S6).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface LoginSpec {
	/** Read by the CLI itself, set in the sign-in terminal. */
	readonly cliEnv: string;
	/** Set in the backend's environment for the default account. */
	readonly backendEnv: string;
	/** Typed in the sign-in terminal (the person presses Enter). */
	readonly command: string;
	/** Whether the CLI has signed in in `home`. */
	readonly signedIn: (home: string) => boolean;
}

function hasGitHubHost(home: string): boolean {
	try {
		return /^github\.com:/m.test(readFileSync(path.join(home, "hosts.yml"), "utf-8"));
	} catch {
		return false;
	}
}

export const LOGIN_SPECS: Readonly<Record<string, LoginSpec>> = {
	copilot: {
		cliEnv: "GH_CONFIG_DIR",
		backendEnv: "COPILOT_GH_CONFIG_DIR",
		command: "gh auth login --hostname github.com --web",
		signedIn: hasGitHubHost,
	},
	codex: {
		cliEnv: "CODEX_HOME",
		backendEnv: "CODEX_HOME",
		command: "codex login",
		signedIn: (home) => existsSync(path.join(home, "auth.json")),
	},
	"gemini-cli": {
		cliEnv: "GEMINI_CLI_HOME",
		backendEnv: "GEMINI_CLI_HOME",
		command: "gemini",
		signedIn: (home) => existsSync(path.join(home, ".gemini", "oauth_creds.json")),
	},
};

export function isLoginProvider(value: unknown): value is string {
	return typeof value === "string" && Object.hasOwn(LOGIN_SPECS, value);
}
