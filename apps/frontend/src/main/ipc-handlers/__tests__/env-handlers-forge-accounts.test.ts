/**
 * @vitest-environment node
 *
 * A project names the saved forge account each forge uses (ENV_UPDATE,
 * ENV_GET): only the id lands in `.workpilot/.env`, never the account's
 * token, and an id that is not an account of that forge is refused before
 * anything is written.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, ProjectEnvConfig } from "../../../shared/types";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return {
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: Handler) =>
				handlers.set(channel, handler),
		},
		app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
		BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
		dialog: {},
		shell: {},
		Menu: {},
		nativeImage: {},
	};
});

vi.mock("../../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../platform")>()),
	isLinux: () => true,
}));

const project = { id: "p1", path: "", autoBuildPath: ".workpilot" };
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => (id === project.id ? project : undefined),
		updateAutoBuildPath: vi.fn(),
	},
}));
vi.mock("../../settings-utils", () => ({ readSettingsFile: () => ({}) }));
vi.mock("../../project-initializer", () => ({
	ensureProjectEnvIgnored: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../claude-cli-utils", () => ({
	getClaudeCliInvocation: vi.fn(),
	getClaudeCliInvocationAsync: vi.fn(),
}));
vi.mock("../../env-utils", () => ({
	getSpawnCommand: vi.fn(),
	getSpawnOptions: vi.fn(),
}));

vi.mock("../../forge/forge-accounts", () => ({
	forgeAccountStore: () => ({
		get: (id: string) => (id === "acct-github" ? { id, forge: "github" } : undefined),
		tokenOf: () => "pat-test-account",
	}),
}));

async function invoke<T>(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return (await handler({}, ...args)) as IPCResult<T>;
}

const envPath = () => path.join(project.path, ".workpilot", ".env");

describe("env-handlers and forge accounts", () => {
	beforeEach(async () => {
		handlers.clear();
		project.path = mkdtempSync(path.join(tmpdir(), "env-accounts-"));
		vi.resetModules();
		const { registerEnvHandlers } = await import("../env-handlers");
		registerEnvHandlers(() => null);
	});

	afterEach(() => {
		rmSync(project.path, { recursive: true, force: true });
	});

	it("saves and reads back the account a project uses, without its token", async () => {
		const config: Partial<ProjectEnvConfig> = {
			githubEnabled: true,
			githubAccountId: "acct-github",
			githubRepo: "acme/app",
		};
		expect(await invoke(IPC_CHANNELS.ENV_UPDATE, project.id, config)).toEqual({ success: true });
		const written = readFileSync(envPath(), "utf-8");
		expect(written).toMatch(/^GITHUB_ACCOUNT_ID=acct-github$/m);
		expect(written).not.toContain("pat-test-account");
		const read = await invoke<ProjectEnvConfig>(IPC_CHANNELS.ENV_GET, project.id);
		expect(read.data?.githubAccountId).toBe("acct-github");

		expect(await invoke(IPC_CHANNELS.ENV_UPDATE, project.id, { githubAccountId: "" })).toEqual({
			success: true,
		});
		expect(readFileSync(envPath(), "utf-8")).not.toMatch(/^GITHUB_ACCOUNT_ID=/m);
	});

	it("refuses an account that is not one of that forge, writing nothing", async () => {
		expect(
			await invoke(IPC_CHANNELS.ENV_UPDATE, project.id, { gitlabAccountId: "acct-github" }),
		).toEqual({ success: false, error: "Unknown account (gitlabAccountId)" });
		expect(existsSync(envPath())).toBe(false);
	});
});
