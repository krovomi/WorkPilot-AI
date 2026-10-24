/**
 * No IPC handler hands a child process the main process env whole.
 *
 * A backend runner gets `pythonRunnerEnv` (utils/python-runner-env.ts), a
 * connector script `envWithoutCredentials` plus its own settings, and a forge
 * runner `getRunnerEnv` (github/utils/runner-env.ts). Spreading `process.env`
 * brings back every credential the main process carries
 * (docs/rules/security.md, S1 and S4).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HANDLERS = path.resolve(__dirname, "..");

// Handlers that run the user's own CLI (Claude Code, Codex…) to install or
// update it: that CLI is the user's tool, run as their shell would run it.
const USER_CLI_INSTALLERS = new Set([
	"claude-code-handlers.ts",
	"credential-handlers.ts",
]);

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) {
			return name === "__tests__" ? [] : sources(full);
		}
		return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
	});
}

describe("IPC handlers build their children's env", () => {
	it("never spread process.env into a child's env", () => {
		const offenders = sources(HANDLERS)
			.filter((file) => !USER_CLI_INSTALLERS.has(path.basename(file)))
			.flatMap((file) =>
				readFileSync(file, "utf-8")
					.split("\n")
					.map((line, index) => ({ line, index }))
					.filter(({ line }) => line.includes("...process.env"))
					.map(
						({ index }) => `${path.relative(HANDLERS, file)}:${index + 1}`,
					),
			);
		expect(offenders).toEqual([]);
	});

	it("still finds the pattern it guards against", () => {
		const installers = [...USER_CLI_INSTALLERS].map((name) =>
			readFileSync(path.join(HANDLERS, name), "utf-8"),
		);
		expect(installers.some((text) => text.includes("...process.env"))).toBe(
			true,
		);
	});
});
