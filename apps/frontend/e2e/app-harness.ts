/**
 * Start the built app the way a new user meets it: a fresh home, a fresh
 * profile, no account. Used by the `*.e2e.ts` specs that drive the real UI.
 * "No account" holds for the environment too: the credentials of the shell
 * that runs the specs (a `GH_TOKEN`, a cloud key, the SSH agent) are left out,
 * so no spec can reach a real service as the developer.
 *
 * Run `pnpm run build` first; on Linux without a display, run under
 * `xvfb-run -a -s "-screen 0 1600x1000x24"` (the CI job does).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ElectronApplication,
	_electron as electron,
	type Page,
} from "@playwright/test";
import { isLinux } from "../src/main/platform";

const FRONTEND = path.resolve(import.meta.dirname, "..");

export interface IsolatedApp {
	app: ElectronApplication;
	page: Page;
	/** Temp root holding the home, the profile and the projects. */
	root: string;
	close: () => Promise<void>;
}

/** The renderer window: the app may also open DevTools in a development build. */
async function mainWindow(app: ElectronApplication): Promise<Page> {
	const isMain = (page: Page) => page.url().endsWith("/renderer/index.html");
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const found = app.windows().find(isMain);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(
		`no renderer window; open windows: ${app.windows().map((w) => w.url())}`,
	);
}

export interface LaunchOptions {
	/** Written as the profile's settings.json before the app starts. */
	settings?: Record<string, unknown>;
	/** A git identity in the home's ~/.gitconfig, as a set-up machine has. */
	gitIdentity?: { name: string; email: string };
	/** Variables added to the app's environment (after the credentials are left out). */
	env?: Record<string, string>;
}

// The shape `src/main/utils/child-env.ts` gives a credential (FOO_API_KEY,
// GH_TOKEN, DB_PASSWORD, AWS_SECRET_ACCESS_KEY, X_PAT…), plus AUTH for the
// SSH agent's socket and the like. Restated rather than imported: that module
// imports a JSON file, which Playwright's ES module loader refuses.
const CREDENTIAL =
	/(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|DSN|AUTH)(_|$)/i;
// Not shaped like one, but a way to the developer's accounts.
const CREDENTIAL_PLACES = new Set(["CLAUDE_CONFIG_DIR", "GH_CONFIG_DIR", "GPG_AGENT_INFO"]);

/** `env` without the variables that carry or point to a credential. */
export function withoutCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (CREDENTIAL.test(name) || CREDENTIAL_PLACES.has(name.toUpperCase())) continue;
		kept[name] = value;
	}
	return kept;
}

export async function launchIsolatedApp(
	options: LaunchOptions = {},
): Promise<IsolatedApp> {
	const root = mkdtempSync(path.join(tmpdir(), "workpilot-e2e-"));
	const home = path.join(root, "home");
	mkdirSync(home);
	if (options.gitIdentity) {
		const { name, email } = options.gitIdentity;
		writeFileSync(
			path.join(home, ".gitconfig"),
			`[user]\n\tname = ${name}\n\temail = ${email}\n`,
		);
	}
	if (options.settings) {
		mkdirSync(path.join(root, "profile"));
		writeFileSync(
			path.join(root, "profile", "settings.json"),
			JSON.stringify(options.settings),
		);
	}
	const app = await electron.launch({
		args: [
			FRONTEND,
			...(isLinux() ? ["--no-sandbox"] : []),
			`--user-data-dir=${path.join(root, "profile")}`,
		],
		env: {
			...withoutCredentials(process.env),
			...options.env,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_DATA_HOME: path.join(home, ".local", "share"),
		},
	});
	const page = await mainWindow(app);
	await page.waitForFunction(
		() => (document.getElementById("root")?.childElementCount ?? 0) > 0,
		null,
		{ timeout: 30_000 },
	);
	return {
		app,
		page,
		root,
		close: async () => {
			await app.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A git repository with one commit, as `Open existing project` expects. */
export function makeGitProject(root: string, name: string): string {
	const dir = path.join(root, name);
	mkdirSync(dir);
	writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "init");
	return dir;
}

/** Make the next native folder picker answer `dir`, without a dialog. */
export async function answerNextFolderPicker(
	app: ElectronApplication,
	dir: string,
): Promise<void> {
	await app.evaluate(({ dialog }, picked) => {
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [picked],
		})) as typeof dialog.showOpenDialog;
	}, dir);
}
