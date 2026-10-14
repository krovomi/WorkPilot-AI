/**
 * @vitest-environment node
 *
 * The project settings screen writes `.workpilot/.env` through ENV_UPDATE and
 * reads it back through ENV_GET. The tokens the backend only takes from its
 * environment land on disk as `enc:` and come back as plaintext; the template
 * cannot grow a secret-shaped key that project-env-secrets.json does not
 * classify. Rule S1.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";
import projectEnvSecrets from "../../../shared/constants/project-env-secrets.json";
import type { IPCResult, ProjectEnvConfig } from "../../../shared/types";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../__tests__/helpers/fake-safe-storage";

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

const fake = sharedFakeSafeStorage();

/** Names that hold a credential, by convention. */
const SECRET_SHAPED = /(?:TOKEN|API_KEY|_PAT|SECRET|PASSWORD|WEBHOOK_URL)$/;

async function invoke<T>(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return (await handler({}, ...args)) as IPCResult<T>;
}

function envFile(): string {
	return readFileSync(path.join(project.path, ".workpilot", ".env"), "utf-8");
}

describe("env-handlers and secrets at rest", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		fake.reset();
		handlers.clear();
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		project.path = mkdtempSync(path.join(tmpdir(), "env-handlers-"));
		vi.resetModules();
		const { registerEnvHandlers } = await import("../env-handlers");
		registerEnvHandlers(() => null);
	});

	afterEach(() => {
		warn.mockRestore();
		rmSync(project.path, { recursive: true, force: true });
	});

	it("writes integration tokens encrypted and reads them back in clear", async () => {
		const config: Partial<ProjectEnvConfig> = {
			claudeOAuthToken: "sk-ant-oat01-project",
			githubEnabled: true,
			githubToken: "ghp_projectToken",
			githubRepo: "acme/app",
			jiraEnabled: true,
			jiraApiToken: "jira-token-value",
			cicdJenkinsToken: "jenkins-token-value",
		};

		expect(await invoke(IPC_CHANNELS.ENV_UPDATE, project.id, config)).toEqual({
			success: true,
		});

		const written = envFile();
		for (const secret of Object.values(config).filter(
			(value) => typeof value === "string" && value !== "acme/app",
		)) {
			expect(written).not.toContain(secret);
		}
		expect(written).toContain(`GITHUB_TOKEN=${fakeEncrypted("ghp_projectToken")}`);
		expect(written).toContain("GITHUB_REPO=acme/app");

		const read = await invoke<ProjectEnvConfig>(IPC_CHANNELS.ENV_GET, project.id);
		expect(read.data).toMatchObject({
			claudeOAuthToken: "sk-ant-oat01-project",
			githubToken: "ghp_projectToken",
			jiraApiToken: "jira-token-value",
			cicdJenkinsToken: "jenkins-token-value",
		});
	});

	it("keeps an encrypted token across a save that does not touch it", async () => {
		await invoke(IPC_CHANNELS.ENV_UPDATE, project.id, {
			githubToken: "ghp_projectToken",
		});
		const before = envFile();

		await invoke(IPC_CHANNELS.ENV_UPDATE, project.id, { defaultBranch: "main" });

		const after = envFile();
		const tokenLine = (content: string) =>
			content.split("\n").find((line) => line.startsWith("GITHUB_TOKEN="));
		expect(tokenLine(after)).toBe(tokenLine(before));
		expect(after).toContain("DEFAULT_BRANCH=main");
	});

	it("classifies every secret-shaped key the template writes", async () => {
		await invoke(IPC_CHANNELS.ENV_UPDATE, project.id, {});

		const templateKeys = envFile()
			.split("\n")
			.map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
			.filter((key): key is string => key !== undefined);
		const classified = new Set([
			...projectEnvSecrets.encrypted,
			...projectEnvSecrets.readable,
		]);

		expect(templateKeys.length).toBeGreaterThan(20);
		expect(
			templateKeys.filter((key) => SECRET_SHAPED.test(key) && !classified.has(key)),
		).toEqual([]);
	});
});
