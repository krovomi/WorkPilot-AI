/**
 * @vitest-environment node
 *
 * The project settings screen saves integration tokens through ENV_UPDATE.
 * They reach `.workpilot/.env` encrypted. ENV_GET never hands them back: the
 * renderer is not trusted (rule S6), it gets MASKED_SECRET for each one set,
 * and the mask sent back means "keep the stored value".
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../__tests__/helpers/fake-safe-storage";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../shared/constants";
import type { ProjectEnvConfig } from "../../../shared/types";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: { id: "p1", path: "", autoBuildPath: ".workpilot" },
	globalSettings: {} as Record<string, unknown>,
	backendFetch: vi.fn(),
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: Handler) =>
				state.handlers.set(channel, handler),
		},
	};
});

vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) =>
			id === state.project.id ? state.project : undefined,
		updateAutoBuildPath: vi.fn(),
	},
}));

vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => state.globalSettings,
}));

vi.mock("../_backend-fetch", () => ({ backendFetch: state.backendFetch }));

vi.mock("../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => tool,
	getToolPathAsync: async (tool: string) => tool,
}));

const fake = sharedFakeSafeStorage();

describe("ENV_UPDATE / ENV_GET secrets", () => {
	beforeEach(async () => {
		fake.reset();
		state.handlers.clear();
		state.globalSettings = {};
		state.backendFetch.mockReset();
		state.project.path = mkdtempSync(path.join(tmpdir(), "env-handlers-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { registerEnvHandlers } = await import("../env-handlers");
		registerEnvHandlers(() => null);
	});

	afterEach(() => {
		rmSync(state.project.path, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = state.handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		return handler({}, ...args);
	}

	function envFile(): string {
		return readFileSync(
			path.join(state.project.path, ".workpilot", ".env"),
			"utf-8",
		);
	}

	async function getConfig(): Promise<ProjectEnvConfig> {
		const result = (await invoke(IPC_CHANNELS.ENV_GET, "p1")) as {
			success: boolean;
			data: ProjectEnvConfig;
		};
		expect(result.success).toBe(true);
		return result.data;
	}

	it("writes the tokens encrypted and hands the renderer only their mask", async () => {
		await expect(
			invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
				claudeOAuthToken: "sk-ant-oat01-secret",
				githubEnabled: true,
				githubToken: "ghp_secret",
				githubRepo: "owner/repo",
				linearApiKey: "lin_api_secret",
				slackWebhookUrl: "https://hooks.slack.com/services/secret",
				mcpServers: { context7ApiKey: "ctx7sk-secret" },
			}),
		).resolves.toEqual({ success: true });

		const raw = envFile();
		expect(raw).not.toContain("secret");
		expect(raw).toContain(`GITHUB_TOKEN=${fakeEncrypted("ghp_secret")}`);
		expect(raw).toContain("GITHUB_REPO=owner/repo");

		const config = await getConfig();
		expect(JSON.stringify(config)).not.toContain("secret");
		expect(config.githubToken).toBe(MASKED_SECRET);
		expect(config.linearApiKey).toBe(MASKED_SECRET);
		expect(config.claudeOAuthToken).toBe(MASKED_SECRET);
		expect(config.slackWebhookUrl).toBe(MASKED_SECRET);
		expect(config.mcpServers?.context7ApiKey).toBe(MASKED_SECRET);
		expect(config.githubRepo).toBe("owner/repo");
		expect(config.gitlabToken).toBeUndefined();
	});

	it("keeps every token when the whole masked config comes back", async () => {
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
			claudeOAuthToken: "sk-ant-oat01-secret",
			githubToken: "ghp_secret",
			openaiApiKey: "sk-proj-secret",
			mcpServers: { context7ApiKey: "ctx7sk-secret" },
		});
		const before = envFile();

		// What the settings screen does on every edit: the whole config, changed.
		const config = await getConfig();
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
			...config,
			githubRepo: "owner/repo",
		});

		const raw = envFile();
		expect(raw).not.toContain(MASKED_SECRET);
		for (const line of [
			`CLAUDE_CODE_OAUTH_TOKEN=${fakeEncrypted("sk-ant-oat01-secret")}`,
			`GITHUB_TOKEN=${fakeEncrypted("ghp_secret")}`,
			`OPENAI_API_KEY=${fakeEncrypted("sk-proj-secret")}`,
			`CONTEXT7_API_KEY=${fakeEncrypted("ctx7sk-secret")}`,
		]) {
			expect(before).toContain(line);
			expect(raw).toContain(line);
		}
		expect(raw).toContain("GITHUB_REPO=owner/repo");
	});

	it("stores what was typed over the mask", async () => {
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { githubToken: "ghp_old" });

		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
			githubToken: `${MASKED_SECRET}ghp_new`,
		});

		expect(envFile()).toContain(`GITHUB_TOKEN=${fakeEncrypted("ghp_new")}`);
	});

	it("does not copy the global Claude token into the project file", async () => {
		state.globalSettings = { globalClaudeOAuthToken: "sk-ant-oat01-global" };

		const config = await getConfig();
		expect(config.claudeTokenIsGlobal).toBe(true);
		expect(config.claudeOAuthToken).toBe(MASKED_SECRET);

		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { ...config });
		expect(envFile()).not.toContain(fakeEncrypted("sk-ant-oat01-global"));
		expect(envFile()).not.toContain("sk-ant-oat01-global");
	});

	describe("notification webhook test", () => {
		const STORED = "https://hooks.slack.com/services/T000/B000/stored";

		beforeEach(async () => {
			state.backendFetch.mockResolvedValue({ success: true });
			await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
				slackWebhookUrl: STORED,
			});
		});

		it("posts the stored URL when the renderer only has the mask", async () => {
			await expect(
				invoke(
					IPC_CHANNELS.ENV_TEST_NOTIFICATION_WEBHOOK,
					"p1",
					"slack",
					MASKED_SECRET,
				),
			).resolves.toEqual({ success: true, data: { delivered: true } });

			expect(state.backendFetch).toHaveBeenCalledTimes(1);
			const [route, init] = state.backendFetch.mock.calls[0];
			expect(route).toBe("/api/notifications/test");
			expect(JSON.parse(init.body)).toEqual({ channel: "slack", url: STORED });
		});

		it("posts a URL that was just typed", async () => {
			await invoke(
				IPC_CHANNELS.ENV_TEST_NOTIFICATION_WEBHOOK,
				"p1",
				"slack",
				"https://hooks.slack.com/services/T000/B000/typed",
			);

			expect(JSON.parse(state.backendFetch.mock.calls[0][1].body).url).toBe(
				"https://hooks.slack.com/services/T000/B000/typed",
			);
		});

		it("refuses an unknown project, an unknown channel, a missing URL", async () => {
			await expect(
				invoke(IPC_CHANNELS.ENV_TEST_NOTIFICATION_WEBHOOK, "nope", "slack"),
			).resolves.toEqual({ success: false, error: "Project not found" });
			await expect(
				invoke(IPC_CHANNELS.ENV_TEST_NOTIFICATION_WEBHOOK, "p1", "irc"),
			).resolves.toEqual({ success: false, error: "Unknown channel" });
			await expect(
				invoke(
					IPC_CHANNELS.ENV_TEST_NOTIFICATION_WEBHOOK,
					"p1",
					"teams",
					MASKED_SECRET,
				),
			).resolves.toEqual({ success: false, error: "No webhook URL" });
			expect(state.backendFetch).not.toHaveBeenCalled();
		});

		it("reports the backend's refusal", async () => {
			state.backendFetch.mockResolvedValue({
				success: false,
				error: "URL refused",
			});

			await expect(
				invoke(IPC_CHANNELS.ENV_TEST_NOTIFICATION_WEBHOOK, "p1", "slack"),
			).resolves.toEqual({ success: false, error: "URL refused" });
		});
	});
});
