import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A feature runner gets the environment `pythonRunnerEnv` builds: the
 * provider the user chose and its key, the Claude sign-in only when that
 * provider needs it, and no other credential of the app. Copying
 * `process.env` and adding the stored keys under names of the caller's own
 * (`CLAUDE_OAUTH_TOKEN`, which the backend never reads) sent every secret to
 * every runner and still started them on Claude.
 */

const spawned = vi.hoisted(() => ({ env: undefined as unknown }));
const runnerEnv = vi.hoisted(() => vi.fn(async () => ({ SELECTED_LLM_PROVIDER: "openai" })));

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/app" } }));
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	return { ...real, existsSync: () => true };
});
vi.mock("node:child_process", () => ({
	spawn: vi.fn((_cmd: string, _args: string[], options: { env: unknown }) => {
		spawned.env = options.env;
		const handlers = { on: vi.fn() };
		return { stdout: handlers, stderr: handlers, on: vi.fn(), kill: vi.fn() };
	}),
}));
vi.mock("../utils/python-runner-env", () => ({ pythonRunnerEnv: runnerEnv }));

const MAIN = path.resolve(__dirname, "..");

describe("feature runner environment", () => {
	beforeEach(() => {
		spawned.env = undefined;
		runnerEnv.mockClear();
	});

	it("is the one pythonRunnerEnv builds for the backend", async () => {
		const { CodeMigrationService } = await import("../code-migration-service");
		const service = new CodeMigrationService();
		service.configure("/venv/bin/python", "/app/backend");
		service.on("error", () => undefined);
		await service.startMigration({
			projectDir: "/work/p",
			migrationDescription: "React 17 to 18",
		});
		expect(runnerEnv).toHaveBeenCalledWith("/app/backend");
		expect(spawned.env).toEqual({ SELECTED_LLM_PROVIDER: "openai" });
	});

	it("is never process.env plus keys picked by hand", () => {
		const offenders = readdirSync(MAIN)
			.filter((name) => name.endsWith("-service.ts"))
			.filter((name) => {
				const source = readFileSync(path.join(MAIN, name), "utf-8");
				if (!/spawn\(\s*(this\.)?_?python(Path|Exe)/.test(source)) return false;
				return (
					/\.\.\.\(?process\.env/.test(source) ||
					/CLAUDE_OAUTH_TOKEN\s*=/.test(source) ||
					/globalClaudeOAuthToken/.test(source)
				);
			});
		expect(offenders).toEqual([]);
	});
});
